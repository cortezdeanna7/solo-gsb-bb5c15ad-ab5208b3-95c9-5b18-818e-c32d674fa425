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
