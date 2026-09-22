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
"""

import copy
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
        annotated.extend(_annotate_resource(ev_rows))

    annotated.sort(key=lambda e: e["received_seq"])
    return annotated


def _annotate_resource(ev_rows):
    """标注单个资源的一组事件(按 received_seq 到达顺序回放)。

    基线回放与分支推演共用同一套规则,保证假设事件与真实事件判定一致。
    """
    ev_rows = sorted(ev_rows, key=lambda r: r["received_seq"])
    expected = 0          # 下一个期望版本
    applied_version = -1  # 已接受的最高版本
    out = []
    for row in ev_rows:
        v = row["version"]
        ev = dict(row)
        if not isinstance(ev.get("payload"), (dict, list)):
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
        out.append(ev)
    return out


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
# 分支推演(纯内存计算,绝不写入 SQLite)
# --------------------------------------------------------------------------- #
def apply_payload(prev, payload):
    """应用一条事件的 payload,返回新配置。

    约定与前端一致:
      {"set": {...}, "remove": ["k"]} 做键级合并/覆盖与删除;
      不含 set/remove 的 payload 整体替换为新配置;
      被拒绝(rejected_conflict)的事件不应用。
    """
    next_cfg = copy.deepcopy(prev if prev is not None else {})
    if (
        isinstance(payload, dict)
        and ("set" in payload or "remove" in payload)
    ):
        if not isinstance(next_cfg, dict):
            next_cfg = {}
        if isinstance(payload.get("set"), dict):
            next_cfg.update(copy.deepcopy(payload["set"]))
        if isinstance(payload.get("remove"), list):
            for key in payload["remove"]:
                next_cfg.pop(key, None)
        return next_cfg
    return copy.deepcopy(payload if payload is not None else {})


def apply_events(events, initial=None):
    """按顺序应用事件(冲突事件跳过),返回最终配置与逐事件快照。"""
    cfg = copy.deepcopy(initial) if initial is not None else None
    snapshots = []
    for ev in events:
        if ev["status"] != "rejected_conflict":
            cfg = apply_payload(cfg, ev["payload"])
        snapshots.append(copy.deepcopy(cfg if cfg is not None else {}))
    return cfg if cfg is not None else {}, snapshots


def config_diff(base, branch):
    """两份最终配置的逐键差异:added / modified / removed。

    配置为 JSON 对象时按顶层键比较;整体替换产生的非对象值用空串键表示。
    """
    added, modified, removed = [], [], []
    if isinstance(base, dict) and isinstance(branch, dict):
        for key in branch:
            if key not in base:
                added.append({"key": key, "value": copy.deepcopy(branch[key])})
            elif base[key] != branch[key]:
                modified.append(
                    {
                        "key": key,
                        "base_value": copy.deepcopy(base[key]),
                        "branch_value": copy.deepcopy(branch[key]),
                    }
                )
        for key in base:
            if key not in branch:
                removed.append({"key": key, "value": copy.deepcopy(base[key])})
    else:
        if base != branch:
            modified.append(
                {
                    "key": "",
                    "base_value": copy.deepcopy(base),
                    "branch_value": copy.deepcopy(branch),
                }
            )
    added.sort(key=lambda d: d["key"])
    modified.sort(key=lambda d: d["key"])
    removed.sort(key=lambda d: d["key"])
    return {"added": added, "modified": modified, "removed": removed}


def event_changes(before, after):
    """一条已应用事件相对应用前快照的新增/修改/删除键(便于定位差异来源)。"""
    diff = config_diff(before, after)
    changed = [d["key"] for d in diff["added"] + diff["modified"] + diff["removed"]]
    return {"added": diff["added"], "modified": diff["modified"],
            "removed": diff["removed"], "keys": changed}


def branch_simulation(db, resource, base_event_id, hypotheses):
    """重建基点状态并推演假设事件,全程只读。

    步骤:
      1. 按原到达顺序取出该资源基点(含)之前的真实事件,用统一规则重放;
      2. 假设事件挂在基点之后,沿用 accepted / gap / rejected_conflict 规则标注;
      3. 分别累积出基线与分支的最终配置,做逐键 diff 并把每个差异键
         归因到最后一次触碰它的分支事件。
    """
    rows = db.execute(
        "SELECT * FROM events WHERE resource = ? ORDER BY received_seq",
        (resource,),
    ).fetchall()
    by_id = {r["id"]: r for r in rows}

    base_seq = 0
    if base_event_id is not None:
        if base_event_id not in by_id:
            return None
        base_seq = by_id[base_event_id]["received_seq"]

    base_rows = [r for r in rows if r["received_seq"] <= base_seq]
    baseline = _annotate_resource(base_rows)

    # 假设事件合成内存行,received_seq 接在基点之后;不落库。
    max_seq = max((r["received_seq"] for r in rows), default=0)
    synth_rows = []
    for i, item in enumerate(hypotheses):
        synth_rows.append(
            {
                "id": None,
                "resource": resource,
                "version": item["version"],
                "author": item.get("author") or "anonymous",
                "payload": item["payload"],
                "note": item.get("note", ""),
                "received_seq": max_seq + 1 + i,
                "created_at": None,
                "branch_index": i,
            }
        )

    branch_events = _annotate_resource(base_rows + synth_rows)[len(base_rows):]

    base_config, _ = apply_events(baseline)
    final_config, snapshots = apply_events(branch_events, initial=base_config)

    # 每条分支事件相对应用前的键级变化;冲突事件不应用,changes 为空。
    changes = []
    for i, ev in enumerate(branch_events):
        before = snapshots[i - 1] if i > 0 else copy.deepcopy(base_config)
        if ev["status"] == "rejected_conflict":
            changes.append({"added": [], "modified": [], "removed": [], "keys": []})
        else:
            changes.append(event_changes(before, snapshots[i]))
    for ev, ch in zip(branch_events, changes):
        ev["changes"] = ch

    diff = config_diff(base_config, final_config)

    # 差异归因:最后一次触碰该键的分支事件(被拒绝的事件不触碰任何键)。
    last_touch = {}
    for i, ch in enumerate(changes):
        for key in ch["keys"]:
            last_touch[key] = i
    causes = {}
    for part in (diff["added"], diff["modified"], diff["removed"]):
        for item in part:
            idx = last_touch.get(item["key"])
            if idx is not None:
                ev = branch_events[idx]
                causes[item["key"]] = {
                    "branch_index": idx,
                    "version": ev["version"],
                    "received_seq": ev["received_seq"],
                    "status": ev["status"],
                    "note": ev.get("note", ""),
                }

    base_event = next(
        (
            {"id": e["id"], "version": e["version"], "received_seq": e["received_seq"]}
            for e in reversed(baseline)
            if e["id"] is not None
        ),
        None,
    )
    return {
        "resource": resource,
        "base_event_id": base_event_id,
        "base_event": base_event,
        "baseline_events": baseline,
        "branch_events": branch_events,
        "baseline_config": base_config,
        "branch_config": final_config,
        "diff": diff,
        "caused_by": causes,
    }


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


@app.post("/api/simulate")
def api_simulate():
    """分支推演:基点重建 + 假设事件标注。只读,绝不写入 SQLite。

    body:
      resource       资源名(必填)
      base_event_id  基点事件 id;null 表示从空状态起推演
      events         假设事件列表,字段 version/author/note/payload,
                     仅在本次请求内存在,按列表顺序挂在基点之后
    """
    body = request.get_json(silent=True) or {}
    resource = str(body.get("resource", "")).strip()
    if not resource:
        return jsonify({"error": "resource 不能为空"}), 400

    if "base_event_id" in body and body["base_event_id"] is not None:
        base_event_id = body["base_event_id"]
        if not isinstance(base_event_id, int) or isinstance(base_event_id, bool):
            return jsonify({"error": "base_event_id 必须是整数或 null"}), 400
    else:
        base_event_id = None

    hypotheses = body.get("events", [])
    if not isinstance(hypotheses, list):
        return jsonify({"error": "events 必须是数组"}), 400
    if len(hypotheses) > 200:
        return jsonify({"error": "单次推演假设事件不能超过 200 条"}), 400

    clean = []
    for i, item in enumerate(hypotheses):
        if not isinstance(item, dict):
            return jsonify({"error": f"第 {i + 1} 条假设事件格式错误"}), 400
        version = item.get("version")
        if not isinstance(version, int) or isinstance(version, bool) or version < 0:
            return jsonify(
                {"error": f"第 {i + 1} 条假设事件的 version 必须是非负整数"}
            ), 400
        payload = item.get("payload", {})
        if not isinstance(payload, (dict, list)):
            return jsonify(
                {"error": f"第 {i + 1} 条假设事件的 payload 必须是 JSON 对象或数组"}
            ), 400
        clean.append(
            {
                "version": version,
                "payload": payload,
                "author": str(item.get("author", "")).strip(),
                "note": str(item.get("note", "")).strip(),
            }
        )

    db = get_db()
    exists = db.execute(
        "SELECT 1 FROM events WHERE resource = ? LIMIT 1", (resource,)
    ).fetchone()
    if not exists:
        return jsonify({"error": f"资源 {resource} 不存在"}), 404

    result = branch_simulation(db, resource, base_event_id, clean)
    if result is None:
        return jsonify({"error": "基点事件不存在或不属于该资源"}), 404
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
