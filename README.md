# 配置变更回放台 (Config Change Replay Console)

本地 Web 工具:为**命名资源**提交**带版本号**的配置变更事件,系统按资源把事件
按**到达顺序**串联起来,检测版本冲突,提供逐步可视化回放与冲突标记,并支持
按资源筛选事件、把当前筛选结果导出为 JSON。

此外支持**分支推演(What-if)**:在单个资源的任意回放事件处建立临时分支,
依次追加多条只存在于浏览器会话内的"假设事件",并排查看分支相对基线最终配置的
逐键新增/修改/删除差异,并定位到导致差异的事件;假设事件不落库、不影响真实数据。

技术栈:**Python Flask + SQLite + 原生 HTML/CSS/JavaScript**(前端零框架、零构建)。

---

## 快速开始

### 方式一:Docker Compose(推荐)

```bash
docker compose up --build
```

打开 <http://localhost:8000> 即可使用。SQLite 数据库保存在命名卷 `replay-data`
(容器内 `/data/replay.db`),容器重启数据不丢失。首次启动会自动建表并写入
一组演示数据(包含"版本跳跃"和"晚到旧版本冲突"场景)。

### 方式二:本地直接运行

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SEED_DEMO=1 REPLAY_DB_PATH=./replay.db python -m app.main
```

然后访问 <http://localhost:8000>。

### 环境变量

| 变量             | 默认值             | 说明                                       |
| ---------------- | ------------------ | ------------------------------------------ |
| `REPLAY_DB_PATH` | `/data/replay.db`  | SQLite 数据库文件路径,启动时自动建库建表   |
| `SEED_DEMO`      | `1`                | 数据库为空时是否写入演示数据,`0` 为关闭    |

> 想清空数据重来:`docker compose down -v` 后重新 `up`(会删除数据卷)。

---

## 它是怎么工作的

### 事件模型

每条事件包含:

| 字段           | 说明                                            |
| -------------- | ----------------------------------------------- |
| `resource`     | 资源名,如 `server-01`,事件按资源串联            |
| `version`      | 非负整数版本号,期望从 `0` 开始连续递增          |
| `author`       | 提交者                                          |
| `payload`      | 变更内容(JSON),见下方"状态合并约定"             |
| `note`         | 备注                                            |
| `received_seq` | 服务端按资源分配的到达序号(回放顺序,自动生成)   |
| `created_at`   | 服务端接收时间(UTC,自动生成)                   |

### 冲突检测规则(以"到达顺序"回放每个资源)

- **已接受 `accepted`**(绿色):版本号等于该资源当前期望的下一个版本,正常应用。
- **版本跳跃 `gap`**(黄色):版本号大于期望值(如已有 v0、v1,突然来 v3)。
  事件仍被接受并展示警告,但版本链不完整 —— 缺失的版本若之后补到,将按下面的规则判冲突。
- **冲突·已拒绝 `rejected_conflict`**(红色):该资源此前**已经接受过相同或更高版本**,
  这条"晚到的旧版本/重复版本"与现状冲突,被拒绝、不改变配置,并记录它与哪个版本冲突。

演示数据中 `feature-x` 完整展示了这一过程:
`v0 → v2(跳跃,缺 v1)→ v1(晚到,与已接受的 v2 冲突)→ v3`。

### 状态合并约定(回放时)

`payload` 为 JSON 对象,支持两种写法:

```json
{ "set": { "cpu": 4, "tag": "canary" }, "remove": ["old_key"] }
```

- `set`:对资源当前配置做键级合并/覆盖;
- `remove`:删除指定键;
- 不含 `set`/`remove` 的 payload 会整体替换资源配置。

被拒绝的冲突事件不参与状态累积 —— 这正是回放面板想展示的效果。

---

## 界面使用

1. **提交变更事件**:左侧表单填写资源名、版本号、提交者与 JSON payload。
   提交后立即提示该事件是"接受 / 跳跃 / 冲突拒绝"。
2. **按资源筛选**:点击资源列表中的任一资源,时间线只显示该资源的事件;
   "查看全部"恢复全局视图(全部资源按到达顺序混排)。
3. **可视化回放**:
   - `◀ / ▶` 单步前进后退,`自动播放` 每 1.2 秒推进一步;
   - 左侧"当前配置状态"实时显示各资源累积配置;
   - 右侧"当前事件"展示 payload 与冲突/跳跃原因横幅;
   - 也可以**直接点击时间线上的任意事件卡片**跳到该步。
4. **导出 JSON**:点击"导出当前结果 JSON",浏览器下载当前筛选条件下
   (全部或单个资源)带汇总统计的完整事件标注结果。

---

## 分支推演(What-if)

针对**单个资源**做"假如当时又到了这几条事件会怎样"的推演。假设事件**只存在于
当前浏览器会话**:不写入 SQLite,刷新页面/切换资源后消失,对真实提交、筛选、
回放与导出行为没有任何影响。

### 操作步骤

1. 先在左侧**选中一个资源**(或使用时间线事件上的「⑂ 建分支」,全局视图下会
   自动切到对应资源)。
2. 在时间线任一事件卡片上点击 **「⑂ 建分支」** —— 该事件(含)即为**基点**;
   后端按原到达顺序把该资源基点之前(含基点)的事件重放一遍,得到基点状态。
   也可以在分支面板选择 **"从空状态"** 起推演。
3. 在分支面板依次**添加多条假设事件**(版本号 + JSON payload,顺序即到达顺序)。
   每条假设事件都会沿用与真实事件完全相同的 `accepted` / `gap` /
   `rejected_conflict` 规则实时标注,冲突事件同样不参与配置累积。
4. 面板**并排展示基线最终配置(@基点)与分支最终配置(含假设事件)**,下方按
   **新增 / 修改 / 删除**三类列出逐键差异;每个差异旁的标签(如
   `由 #2 · v3 · 已接受 导致 →`)点击即可滚动并高亮**最后一次触碰该键**的
   假设事件,完成差异定位。
5. 单条假设事件可用 `✕` 移除(其后事件按到达顺序重新标注);点击 **"放弃分支"**
   清空整个分支。
6. **切换基点或切换资源会清空未提交的分支**(有假设事件时会先弹窗确认)。

> 基点选择在回放"第几步"之外独立存在,不影响上方原有的单步回放。

### 接口:`POST /api/simulate`

只读接口 —— 全程在内存中重建状态,**不执行任何 INSERT/UPDATE**。

请求体:

```json
{
  "resource": "feature-x",
  "base_event_id": 6,
  "events": [
    {"version": 1, "author": "dave", "note": "假设 v1 晚到", "payload": {"set": {"late": 1}}},
    {"version": 3, "author": "carol", "payload": {"set": {"rollout": 75}}}
  ]
}
```

| 字段            | 说明                                                          |
| --------------- | ------------------------------------------------------------- |
| `resource`      | 资源名(必填,须已存在)                                        |
| `base_event_id` | 基点事件 id;`null` 表示从空状态起推演                          |
| `events`        | 假设事件数组(最多 200 条),按数组顺序作为到达顺序,不落库       |

响应要点:

```json
{
  "resource": "feature-x",
  "base_event": {"id": 6, "version": 2, "received_seq": 6},
  "baseline_events": [ {"id": 5, "version": 0, "status": "accepted"} ],
  "branch_events": [
    {"id": null, "version": 1, "status": "rejected_conflict",
     "conflict_with": 2, "branch_index": 0, "changes": {"keys": []}},
    {"id": null, "version": 3, "status": "accepted",
     "branch_index": 1, "changes": {"keys": ["rollout"]}}
  ],
  "baseline_config": {"enabled": true, "rollout": 50},
  "branch_config": {"enabled": true, "rollout": 75},
  "diff": {
    "added": [],
    "modified": [{"key": "rollout", "base_value": 50, "branch_value": 75}],
    "removed": []
  },
  "caused_by": {
    "rollout": {"branch_index": 1, "version": 3, "status": "accepted", "note": ""}
  }
}
```

- `branch_events` 中 `id` 恒为 `null`,并带会话内序号 `branch_index`;
- `changes.keys` 为该事件相对应用前所实际改动的配置键(冲突事件为空);
- `caused_by` 把每个差异键归因到**最后一次修改它的假设事件**(被拒绝事件不会
  成为归因来源)。

错误:缺资源/资源不存在、`version` 非非负整数、payload 非 JSON 对象/数组、
基点不存在或不属于该资源、假设事件超过 200 条,分别返回 `400` / `404`。

---

## HTTP API

| 方法 & 路径              | 说明                                         |
| ------------------------ | -------------------------------------------- |
| `GET /api/events`        | 事件列表;`?resource=server-01` 按资源筛选    |
| `POST /api/events`       | 提交一条事件(JSON body,字段见事件模型),**写入 SQLite** |
| `POST /api/simulate`     | 分支推演:基点重建 + 假设事件标注,**只读、不写库** |
| `GET /api/export`        | 导出当前筛选结果为 JSON 附件下载             |

提交示例:

```bash
curl -X POST http://localhost:8000/api/events \
  -H 'Content-Type: application/json' \
  -d '{
        "resource": "server-01",
        "version": 4,
        "author": "alice",
        "note": "降级",
        "payload": {"set": {"cpu": 2}}
      }'
```

导出示例:

```bash
# 全部资源
curl -OJ http://localhost:8000/api/export
# 仅 server-01
curl -OJ "http://localhost:8000/api/export?resource=server-01"
```

分支推演示例(以 `feature-x` 的 v2 事件 id=6 为基点,假设 v1 晚到、v3 变更):

```bash
curl -X POST http://localhost:8000/api/simulate \
  -H 'Content-Type: application/json' \
  -d '{
        "resource": "feature-x",
        "base_event_id": 6,
        "events": [
          {"version": 1, "author": "dave", "payload": {"set": {"enabled": true}}},
          {"version": 3, "author": "carol", "payload": {"set": {"rollout": 75}}}
        ]
      }'
```

导出文件结构:

```json
{
  "exported_at": "2026-09-21T12:00:00.000000+00:00",
  "filter": { "resource": "server-01" },
  "summary": { "total": 4, "accepted": 4, "rejected_conflict": 0, "gap": 0 },
  "events": [ { "id": 1, "status": "accepted", "conflict_with": null, "...": "..." } ]
}
```

---

## 项目结构

```
.
├── app/main.py            # Flask 应用:建库、冲突标注、事件/分支推演/导出 API
├── templates/index.html   # 单页面结构(含分支推演面板)
├── static/css/styles.css  # 深色控制台主题
├── static/js/app.js       # 原生 JS:渲染、回放状态机、筛选、分支推演、导出
├── requirements.txt
├── Dockerfile             # python:3.12-slim,启动自动初始化数据库
├── docker-compose.yml     # 端口 8000 + 持久化卷 + 演示数据开关
└── README.md
```
