# 配置变更回放台 (Config Change Replay Console)

本地 Web 工具:为**命名资源**提交**带版本号**的配置变更事件,系统按资源把事件
按**到达顺序**串联起来,检测版本冲突,提供逐步可视化回放与冲突标记,支持
按资源筛选事件、在任意事件处建立**临时分支**做假设推演与逐键差异对比,并支持
把当前筛选结果导出为 JSON。

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

## 分支推演(What-if)

在**不改动真实数据**的前提下回答:"如果基点之后换几条事件到达,最终配置会怎样?"

- **建立分支**:时间线上每条事件卡片右侧都有 `🌿 建分支` 按钮,点击即以该事件
  为**基点**建立临时分支(基点包含该事件本身)。在"全部资源"视图建分支会自动
  切换到该资源视图。
- **追加假设事件**:在分支面板依次填写版本号、提交者、备注与 payload,点
  "追加假设事件"。假设事件严格按**添加顺序**到达,后端先按原到达顺序重放
  基点之前的真实事件重建节点状态,再沿用同一套
  `accepted / gap / rejected_conflict` 规则标注每条假设事件。
- **并排差异**:面板三栏并排展示**基线最终配置**(基点处的真实配置)、
  **逐键差异** 与 **分支最终配置**。差异按顶层键分为新增(绿)/修改(黄)/
  删除(红),每行附带"⮞ 假设事件 #N"按钮,点击可定位到导致该差异的事件
  (取最后一个改动该键的事件;被拒绝的事件不改变配置,因此不会成为致因)。
- **删除 / 放弃**:每条假设事件可单独删除并重算;"✕ 放弃分支"或再次在别的
  事件上建分支可结束当前推演。
- **会话隔离**:假设事件只保存在浏览器内存中,随页面请求发给后端即时重算,
  **绝不写入 SQLite**(后端推演路径只执行 `SELECT`),刷新页面即消失。
- **切换清空**:**切换基点或切换资源**(含"查看全部"、左侧资源列表、
  提交真实事件后自动跳转)时,未提交的临时分支会被清空;分支内若已有假设
  事件,界面会先弹确认框。

> 版本默认填为"基点之后下一个期望版本",但允许任意填写:填旧版本可复现
> `rejected_conflict`,跳号可复现 `gap`。

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
4. **分支推演**:在任意事件卡片上点 `🌿 建分支`,在分支面板逐条追加假设事件,
   查看基线/分支最终配置的逐键差异并定位致因事件(详见上方"分支推演")。
5. **导出 JSON**:点击"导出当前结果 JSON",浏览器下载当前筛选条件下
   (全部或单个资源)带汇总统计的完整事件标注结果。

---

## HTTP API

| 方法 & 路径              | 说明                                         |
| ------------------------ | -------------------------------------------- |
| `GET /api/events`        | 事件列表;`?resource=server-01` 按资源筛选    |
| `POST /api/events`       | 提交一条事件(JSON body,字段见事件模型)       |
| `POST /api/simulate`     | 分支推演:基点 + 假设事件,只读不落库          |
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

导出文件结构:

```json
{
  "exported_at": "2026-09-21T12:00:00.000000+00:00",
  "filter": { "resource": "server-01" },
  "summary": { "total": 4, "accepted": 4, "rejected_conflict": 0, "gap": 0 },
  "events": [ { "id": 1, "status": "accepted", "conflict_with": null, "...": "..." } ]
}
```

### 分支推演接口 `POST /api/simulate`

只读接口:后端按 `base_event_id` 找到基点事件,先按原到达顺序重放该资源
`received_seq` 不晚于基点的真实事件重建状态,再顺序标注请求里的假设事件。
**全程不写 SQLite**;假设事件没有 `id` / `received_seq`,以 `branch_seq`
(从 1 开始)标识。单次最多 200 条假设事件。

请求:

```bash
curl -X POST http://localhost:8000/api/simulate \
  -H 'Content-Type: application/json' \
  -d '{
        "base_event_id": 6,
        "events": [
          {"version": 1, "author": "eve", "note": "假设迟到版本",
           "payload": {"set": {"enabled": false}}},
          {"version": 3, "author": "eve", "note": "假设放量",
           "payload": {"set": {"rollout": 75, "region": "cn"}}}
        ]
      }'
```

响应(节选):

```json
{
  "resource": "feature-x",
  "base_event_id": 6,
  "base_seq": 2,
  "next_expected_version": 4,
  "base_config": {"enabled": true, "rollout": 50},
  "branch_config": {"enabled": false, "rollout": 75, "region": "cn"},
  "diffs": [
    {"key": "region", "kind": "added", "base_value": null, "branch_value": "cn",
     "caused_by": {"branch_seq": 2, "label": "假设事件 #2"}},
    {"key": "rollout", "kind": "modified", "base_value": 50, "branch_value": 75,
     "caused_by": {"branch_seq": 2, "label": "假设事件 #2"}}
  ],
  "branch_events": [
    {"branch_seq": 1, "version": 1, "status": "rejected_conflict",
     "conflict_with": 2, "hypothetical": true, "changed_keys": {"added": [], "modified": [], "removed": []}},
    {"branch_seq": 2, "version": 3, "status": "accepted", "conflict_with": null,
     "hypothetical": true, "changed_keys": {"added": ["region"], "modified": ["rollout"], "removed": []}}
  ]
}
```

- `diffs[].kind`:`added` / `modified` / `removed`;
- `diffs[].caused_by`:最后一个改动该键的假设事件(被拒绝事件不改动任何键)。
- 错误:`400` 参数非法(`base_event_id` 非整数、`version` 不是非负整数、
  `payload` 非对象/数组、事件超量),`404` 基点事件不存在。

---

## 项目结构

```
.
├── app/main.py            # Flask 应用:建库、冲突标注、事件/推演/导出 API
├── templates/index.html   # 单页面结构
├── static/css/styles.css  # 深色控制台主题
├── static/js/app.js       # 原生 JS:渲染、回放状态机、分支推演、筛选、导出
├── requirements.txt
├── Dockerfile             # python:3.12-slim,启动自动初始化数据库
├── docker-compose.yml     # 端口 8000 + 持久化卷 + 演示数据开关
└── README.md
```
