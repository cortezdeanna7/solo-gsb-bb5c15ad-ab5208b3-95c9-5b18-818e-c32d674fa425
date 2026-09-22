"""配置变更回放台 - Flask + SQLite 后端。

核心概念:
  - resource : 命名资源(如 server-01 / feature-x),按资源串联事件。
  - version  : 每次变更携带的期望版本号(非负整数),从 0 开始递增。
  - event    : 一次提交的变更,按 (resource, received_seq) 构成到达序列。

冲突检测:
  - rejected_conflict : 该资源此前已有 >= v 的版本被接受(旧版本/重复版本晚到)。
  - gap               : 首次出现即跳跃(v 大于资源当前期望版本),版本链不连续。
    间隙之后如果缺失版本补到,会按"晚到的旧版本"判为 rejected_conflict,
    这样检测严格按"到达顺序"回放,符合"回放台"语义。

分支推演(/api/simulate):
  - 仅做 SELECT,绝不写入 SQLite;假设事件只活在调用方(浏览器)会话里。
  - 先按原到达顺序重放到基点事件,得到基线状态与版本机游标,
    再顺序标注调用方提交的假设事件,规则与正式事件完全一致。
"""

import json
import os
import sqlite3
from datetime import datetime, timezone

from flask import Flask, Response, g, jsonify, render_template, request

DB_PATH = os.environ.get("REPLAY_DB_PATH", "/data/replay.db")
# 数据库为空且 SEED_DEMO=1 时写入演示数据(Compose 默认开启)。
SEED_DEMO = os.environ.get("SEED_DEMO", "1") == "1"

app = Flask(__name__, static_folder="../static", template_folder="../templates")


# --------------------------------------------------------------------------- #
# 数据库
# --------------------------------------------------------------------------- #
def get_db():
    if "db" not in g:
        db_dir = os.path.dirname(DB_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(seed=False):
    """建表;可选写入演示数据。幂等,启动时执行。"""
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            resource      TEXT    NOT NULL,
            version       INTEGER NOT NULL CHECK (version >= 0),
            author        TEXT    NOT NULL DEFAULT '',
            payload       TEXT    NOT NULL DEFAULT '{}',
            note          TEXT    NOT NULL DEFAULT '',
            received_seq  INTEGER NOT NULL,
            created_at    TEXT    NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_resource_seq "
        "ON events(resource, received_seq)"
    )
    conn.commit()

    if seed:
        count = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        if count == 0:
            _seed_demo(conn)
    conn.commit()
    conn.close()


def _seed_demo(conn):
    """两条资源线:一条干净演进,一条制造 跳跃 + 晚到旧版本 冲突。"""
    now = datetime.now(timezone.utc)
    demo = [
        # resource, version, author, payload, note
        ("server-01", 0, "alice", {"set": {"role": "web", "cpu": 2}}, "初始化上线"),
        ("server-01", 1, "alice", {"set": {"cpu": 4}}, "升配"),
        ("server-01", 2, "bob", {"set": {"tag": "canary"}}, "灰度标记"),
        ("server-01", 3, "bob", {"remove": ["tag"]}, "灰度结束摘除标记"),
        ("feature-x", 0, "carol", {"set": {"enabled": False}}, "创建开关"),
        # 版本 2 先到 -> 跳跃间隙(缺 v1)
        ("feature-x", 2, "carol", {"set": {"enabled": True, "rollout": 50}}, "放量 50%"),
        # 版本 1 晚到 -> 与已接受的 v2 冲突,拒绝
        ("feature-x", 1, "dave", {"set": {"enabled": True}}, "迟到的小流量变更"),
        ("feature-x", 3, "carol", {"set": {"rollout": 100}}, "全量"),
    ]
    for i, (resource, version, author, payload, note) in enumerate(demo):
        conn.execute(
            "INSERT INTO events(resource, version, author, payload, note, "
            "received_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                resource,
                version,
                author,
                json.dumps(payload, ensure_ascii=False),
                note,
                i + 1,
                f"{now.isoformat()}#{i + 1}",
            ),
        )


# --------------------------------------------------------------------------- #
# 业务逻辑
# --------------------------------------------------------------------------- #
def _parse_payload(raw):
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return {"_raw": raw}


def annotate(rows):
    """按资源以"到达顺序"回放,标注每个事件的接受/冲突/间隙状态。

    返回事件 dict 列表(原始到达顺序),并附带:
      status: accepted | rejected_conflict | gap
      expected_version / applied_version / conflict_with
    """
    by_resource = {}
    for row in rows:
        by_resource.setdefault(row["resource"], []).append(row)

    annotated = []
    for resource, ev_rows in by_resource.items():
        ev_rows.sort(key=lambda r: r["received_seq"])
        expected = 0          # 下一个期望版本
        applied_version = -1  # 已接受的最高版本
        for row in ev_rows:
            v = row["version"]
            ev = dict(row)
            ev["payload"] = _parse_payload(row["payload"])
            ev["expected_version"] = expected
            ev["applied_version"] = applied_version
            ev["conflict_with"] = None

            if v < expected:
                # 该版本(或更高)此前已接受:旧版本/重复版本晚到。
                ev["status"] = "rejected_conflict"
                ev["conflict_with"] = applied_version
            elif v == expected:
                ev["status"] = "accepted"
                applied_version = v
                expected = v + 1
            else:  # v > expected:版本跳跃,接受但标记间隙;
                  # 版本链从 v 继续,缺失版本之后补到将被判为晚到冲突。
                ev["status"] = "gap"
                applied_version = v
                expected = v + 1
            annotated.append(ev)

    annotated.sort(key=lambda e: e["received_seq"])
    return annotated


def query_events(db, resource=None):
    if resource:
        rows = db.execute(
            "SELECT * FROM events WHERE resource = ? ORDER BY received_seq",
            (resource,),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM events ORDER BY received_seq"
        ).fetchall()
    return annotate(rows)


def resource_summary(db):
    """每个资源的事件数 / 冲突数 / 最新版本。"""
    rows = db.execute(
        """
        SELECT resource,
               COUNT(*)                          AS total,
               MAX(version)                      AS max_version,
               MAX(received_seq)                 AS max_seq
        FROM events GROUP BY resource ORDER BY resource
        """
    ).fetchall()
    result = []
    for row in rows:
        evs = query_events(db, row["resource"])
        result.append(
            {
                "resource": row["resource"],
                "total": row["total"],
                "max_version": row["max_version"],
                "conflicts": sum(
                    1 for e in evs if e["status"] == "rejected_conflict"
                ),
                "gaps": sum(1 for e in evs if e["status"] == "gap"),
            }
        )
    return result


# --------------------------------------------------------------------------- #
# 配置状态机:与前端 static/js/app.js 中 applyPayload 保持同一套语义。
# payload: {"set": {...} 键级合并/覆盖, "remove": ["k"] 删键};
# 不含 set/remove 时整体替换。rejected_conflict 事件不参与累积。
# --------------------------------------------------------------------------- #
_MISSING = object()


def apply_config(prev, payload):
    """把单个已接受事件的 payload 应用到配置上,返回新配置。"""
    if isinstance(payload, dict) and ("set" in payload or "remove" in payload):
        next_cfg = dict(prev) if isinstance(prev, dict) else {}
        if isinstance(payload.get("set"), dict):
            next_cfg.update(payload["set"])
        if isinstance(payload.get("remove"), list):
            for k in payload["remove"]:
                next_cfg.pop(k, None)
        return next_cfg
    # 不含 set/remove:整体替换(与前端一致,可能是对象/数组/标量)。
    return payload if payload is not None else {}


def config_after(events):
    """按顺序累积已接受事件(非 rejected_conflict)后的最终配置。"""
    cfg = {}
    for ev in events:
        if ev["status"] == "rejected_conflict":
            continue
        cfg = apply_config(cfg, ev["payload"])
    return cfg


def changed_keys(before, after):
    """返回应用一条事件后新增/修改/删除的顶层键。

    仅在前后都是 dict 时有意义;整体替换成非对象配置时返回空集合
    (这类场景在逐键差异面板中以 added/removed 全量呈现,无需细粒度归因)。
    """
    added, modified, removed = set(), set(), set()
    if not isinstance(before, dict) or not isinstance(after, dict):
        return added, modified, removed
    for k, val in after.items():
        old = before.get(k, _MISSING)
        if old is _MISSING:
            added.add(k)
        elif old != val:
            modified.add(k)
    for k in before:
        if k not in after:
            removed.add(k)
    return added, modified, removed


def simulate_branch(db, resource, base_seq, hypotheticals):
    """分支推演核心:只读,不触碰 SQLite 写路径。

    1. 取该资源 received_seq <= base_seq 的真实事件,按原到达顺序回放,
       得到基线事件标注与基线配置、版本机游标(expected / applied_version);
    2. 在游标之上顺序重放假设事件,沿用 accepted / gap / rejected_conflict
       规则标注,并逐键记录每条假设事件造成的配置变化;
    3. 返回基线/分支最终配置、逐键差异(附致因假设事件)与完整标注列表。
    """
    rows = db.execute(
        "SELECT * FROM events WHERE resource = ? AND received_seq <= ? "
        "ORDER BY received_seq",
        (resource, base_seq),
    ).fetchall()
    base_events = annotate(rows)
    base_config = config_after(base_events)

    # 从基点最后一条事件的标注恢复版本机游标 —— 与 annotate 内部状态等价。
    if not base_events:
        expected, applied_version = 0, -1
    else:
        last = base_events[-1]
        if last["status"] == "rejected_conflict":
            # 被拒绝事件不推进游标:期望值与已接受最高版本均保持不变。
            expected = last["expected_version"]
            applied_version = last["applied_version"]
        else:
            expected = last["version"] + 1
            applied_version = last["version"]

    branch_events = []
    # JSON 往返做深拷贝,与前端 clone() 语义一致(数据均来自 JSON 解析)。
    branch_config = json.loads(json.dumps(base_config))
    # 键 -> 最后改动它的假设事件序号(branch_seq),用于差异归因。
    caused_by = {}

    for i, h in enumerate(hypotheticals):
        v = h["version"]
        ev = {
            "id": None,
            "resource": resource,
            "version": v,
            "author": h.get("author") or "anonymous",
            "payload": h.get("payload", {}),
            "note": h.get("note", ""),
            "received_seq": None,          # 假设事件没有真实到达序号
            "branch_seq": i + 1,
            "hypothetical": True,
            "expected_version": expected,
            "applied_version": applied_version,
            "conflict_with": None,
        }

        before = branch_config
        if v < expected:
            ev["status"] = "rejected_conflict"
            ev["conflict_with"] = applied_version
            ev["changed_keys"] = {"added": [], "modified": [], "removed": []}
        else:
            if v == expected:
                ev["status"] = "accepted"
            else:
                ev["status"] = "gap"
            after = apply_config(before, ev["payload"])
            added, modified, removed = changed_keys(before, after)
            ev["changed_keys"] = {
                "added": sorted(added),
                "modified": sorted(modified),
                "removed": sorted(removed),
            }
            for k in added | modified | removed:
                caused_by[k] = ev["branch_seq"]
            branch_config = after
            applied_version = v
            expected = v + 1

        branch_events.append(ev)

    diffs = _config_diffs(base_config, branch_config, caused_by)
    return {
        "resource": resource,
        "base_seq": base_seq,
        "next_expected_version": expected,
        "applied_version": applied_version,
        "base_events": base_events,
        "branch_events": branch_events,
        "base_config": base_config,
        "branch_config": branch_config,
        "diffs": diffs,
    }


def _config_diffs(base_config, branch_config, caused_by):
    """逐键对比基线/分支最终配置,生成新增/修改/删除差异并附致因。"""
    def cause(branch_seq):
        if branch_seq is None:
            return None
        return {"branch_seq": branch_seq, "label": f"假设事件 #{branch_seq}"}

    diffs = []
    if not isinstance(base_config, dict) or not isinstance(branch_config, dict):
        return diffs
    for k in sorted(set(base_config) | set(branch_config)):
        in_base, in_branch = k in base_config, k in branch_config
        if in_branch and not in_base:
            kind, base_val, branch_val = "added", None, branch_config[k]
        elif in_base and not in_branch:
            kind, base_val, branch_val = "removed", base_config[k], None
        elif base_config[k] != branch_config[k]:
            kind, base_val, branch_val = "modified", base_config[k], branch_config[k]
        else:
            continue
        diffs.append({
            "key": k,
            "kind": kind,
            "base_value": base_val,
            "branch_value": branch_val,
            "caused_by": cause(caused_by.get(k)),
        })
    return diffs


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/events")
def api_events():
    resource = request.args.get("resource", "").strip() or None
    db = get_db()
    return jsonify(
        {
            "events": query_events(db, resource),
            "resources": resource_summary(db),
            "filter": resource or "",
        }
    )


@app.post("/api/events")
def api_create_event():
    body = request.get_json(silent=True) or {}
    resource = str(body.get("resource", "")).strip()
    author = str(body.get("author", "")).strip() or "anonymous"
    note = str(body.get("note", "")).strip()
    payload = body.get("payload", {})
    version = body.get("version")

    if not resource:
        return jsonify({"error": "resource 不能为空"}), 400
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        return jsonify({"error": "version 必须是非负整数"}), 400
    if not isinstance(payload, (dict, list)):
        return jsonify({"error": "payload 必须是 JSON 对象或数组"}), 400

    db = get_db()
    max_seq = db.execute(
        "SELECT COALESCE(MAX(received_seq), 0) FROM events WHERE resource = ?",
        (resource,),
    ).fetchone()[0]
    created_at = datetime.now(timezone.utc).isoformat()
    cur = db.execute(
        "INSERT INTO events(resource, version, author, payload, note, "
        "received_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            resource,
            version,
            author,
            json.dumps(payload, ensure_ascii=False),
            note,
            max_seq + 1,
            created_at,
        ),
    )
    db.commit()

    # 回放该资源,定位刚插入事件的标注结果。
    evs = query_events(db, resource)
    created = next(e for e in evs if e["id"] == cur.lastrowid)
    return jsonify({"event": created, "resources": resource_summary(db)}), 201


SIMULATE_MAX_EVENTS = 200


@app.post("/api/simulate")
def api_simulate():
    """分支推演:在某资源基点事件之后追加若干假设事件,重放并对比差异。

    全程只读,不写入 SQLite。body:
      base_event_id : int  基点事件(真实事件)的 id
      events        : list  假设事件 [{version, author, note, payload}]
    """
    body = request.get_json(silent=True) or {}
    base_id = body.get("base_event_id")
    hypotheticals = body.get("events", [])

    if not isinstance(base_id, int) or isinstance(base_id, bool):
        return jsonify({"error": "base_event_id 必须是整数事件 id"}), 400
    if not isinstance(hypotheticals, list):
        return jsonify({"error": "events 必须是假设事件数组"}), 400
    if len(hypotheticals) > SIMULATE_MAX_EVENTS:
        return jsonify(
            {"error": f"单次推演最多 {SIMULATE_MAX_EVENTS} 条假设事件"}
        ), 400

    cleaned = []
    for i, h in enumerate(hypotheticals):
        if not isinstance(h, dict):
            return jsonify({"error": f"第 {i + 1} 条假设事件必须是对象"}), 400
        v = h.get("version")
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            return jsonify(
                {"error": f"第 {i + 1} 条假设事件的 version 必须是非负整数"}
            ), 400
        payload = h.get("payload", {})
        if not isinstance(payload, (dict, list)):
            return jsonify(
                {"error": f"第 {i + 1} 条假设事件的 payload 必须是 JSON 对象或数组"}
            ), 400
        cleaned.append(
            {
                "version": v,
                "author": str(h.get("author", "")).strip() or "anonymous",
                "note": str(h.get("note", "")).strip(),
                "payload": payload,
            }
        )

    db = get_db()  # 只读使用:simulate_branch 内仅执行 SELECT。
    base = db.execute(
        "SELECT resource, received_seq FROM events WHERE id = ?", (base_id,)
    ).fetchone()
    if base is None:
        return jsonify({"error": "基点事件不存在"}), 404

    result = simulate_branch(
        db, base["resource"], base["received_seq"], cleaned
    )
    result["base_event_id"] = base_id
    return jsonify(result)


@app.get("/api/export")
def api_export():
    """导出当前筛选(可按 resource)结果为 JSON 下载。"""
    resource = request.args.get("resource", "").strip() or None
    db = get_db()
    events = query_events(db, resource)

    accepted = sum(1 for e in events if e["status"] == "accepted")
    conflicts = sum(1 for e in events if e["status"] == "rejected_conflict")
    gaps = sum(1 for e in events if e["status"] == "gap")

    payload_doc = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "filter": {"resource": resource or "*"},
        "summary": {
            "total": len(events),
            "accepted": accepted,
            "rejected_conflict": conflicts,
            "gap": gaps,
        },
        "events": events,
    }
    blob = json.dumps(payload_doc, ensure_ascii=False, indent=2)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slug = resource if resource else "all"
    filename = f"config-events-{slug}-{stamp}.json"
    return Response(
        blob,
        mimetype="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":
    init_db(seed=SEED_DEMO)
    app.run(host="0.0.0.0", port=8000)
