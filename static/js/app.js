/* 配置变更回放台 - 原生 JS,无任何框架依赖。 */

const state = {
  events: [],
  resources: [],
  filter: "",        // 资源名,空串表示全部
  step: -1,          // 回放到第几个事件(-1 = 未开始)
  playing: false,
  timer: null,
  // 分支推演会话:基点 + 仅存于浏览器内存的假设事件 + 最近一次推演结果。
  // 切换基点 / 资源 / 提交真实事件时会被清空(见 discardBranch)。
  branch: null,
};

const $ = (sel) => document.querySelector(sel);

const api = {
  async list(resource = "") {
    const qs = resource ? `?resource=${encodeURIComponent(resource)}` : "";
    const r = await fetch(`/api/events${qs}`);
    if (!r.ok) throw new Error((await r.json()).error || "加载失败");
    return r.json();
  },
  async create(body) {
    const r = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "提交失败");
    return data;
  },
  async simulate(baseEventId, events) {
    const r = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_event_id: baseEventId, events }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "推演失败");
    return data;
  },
};

// --------------------------------------------------------------------------- //
// 配置状态机:回放时按事件累积每个资源的配置。
// 约定 payload: {"set": {...} 合并/覆盖, "remove": ["k"] 删除键};
// 不带 set/remove 的 payload 直接整体替换为新配置。冲突事件不应用。
// --------------------------------------------------------------------------- //
const clone = (v) => JSON.parse(JSON.stringify(v));

function applyPayload(prev, payload) {
  const next = clone(prev ?? {});
  if (payload && typeof payload === "object" && !Array.isArray(payload) &&
      ("set" in payload || "remove" in payload)) {
    if (payload.set && typeof payload.set === "object") {
      Object.assign(next, clone(payload.set));
    }
    if (Array.isArray(payload.remove)) {
      payload.remove.forEach((k) => delete next[k]);
    }
    return next;
  }
  return clone(payload ?? {});
}

function statesThrough(index) {
  const states = {};
  for (let i = 0; i <= index; i++) {
    const ev = state.events[i];
    if (ev.status === "rejected_conflict") continue; // 冲突事件被拒绝,不改变配置
    states[ev.resource] = applyPayload(states[ev.resource], ev.payload);
  }
  return states;
}

// --------------------------------------------------------------------------- //
// 渲染
// --------------------------------------------------------------------------- //
function fmtTime(raw) {
  const iso = String(raw).split("#")[0];
  const d = new Date(iso);
  return isNaN(d) ? raw : d.toLocaleString();
}

const STATUS_LABEL = {
  accepted: "已接受",
  gap: "版本跳跃",
  rejected_conflict: "冲突·已拒绝",
};

function renderResources() {
  const box = $("#resourceList");
  if (!state.resources.length) {
    box.innerHTML = `<p class="muted">还没有任何事件,先在左侧提交一条。</p>`;
    return;
  }
  box.innerHTML = state.resources.map((r) => `
    <div class="resource-item ${r.resource === state.filter ? "active" : ""}"
         data-resource="${encodeURIComponent(r.resource)}">
      <span class="rname">${r.resource}</span>
      <span class="rmeta">
        v${r.max_version} · ${r.total} 条
        ${r.gaps ? `<span class="badge gap">跳 ${r.gaps}</span>` : ""}
        ${r.conflicts ? `<span class="badge conflict">冲 ${r.conflicts}</span>` : ""}
      </span>
    </div>
  `).join("");

  box.querySelectorAll(".resource-item").forEach((el) => {
    el.addEventListener("click", () => {
      const next = decodeURIComponent(el.dataset.resource);
      if (state.filter === next) return;
      if (state.branch && state.branch.resource !== next &&
          !confirmDiscardBranch("切换资源")) return;
      state.filter = next;
      // 切换资源时清空未提交分支(分支资源与当前筛选不再匹配)。
      if (state.branch && state.branch.resource !== next) discardBranch();
      load();
    });
  });
}

function renderTopStats() {
  const evs = state.events;
  const n = (s) => evs.filter((e) => e.status === s).length;
  $("#topStats").innerHTML = `
    <span class="stat-pill">事件 <b>${evs.length}</b></span>
    <span class="stat-pill"><span class="ok">接受 ${n("accepted") + n("gap")}</span></span>
    <span class="stat-pill"><span class="warn">跳跃 ${n("gap")}</span></span>
    <span class="stat-pill"><span class="danger">冲突 ${n("rejected_conflict")}</span></span>
  `;
}

function renderTimeline() {
  const box = $("#timeline");
  $("#filterTag").textContent = state.filter ? `· 资源 ${state.filter}` : "· 全部资源(按到达顺序)";

  if (!state.events.length) {
    box.innerHTML = `<div class="empty">当前筛选下没有事件</div>`;
    return;
  }

  box.innerHTML = state.events.map((ev, i) => {
    const isBase = state.branch && state.branch.baseEventId === ev.id;
    return `
    <div class="t-event ${ev.status}${isBase ? " base" : ""}" data-index="${i}">
      <div class="t-head">
        <span class="t-version">v${ev.version}</span>
        <span class="t-resource">${escapeHtml(ev.resource)}</span>
        <span class="t-author">@${escapeHtml(ev.author)}</span>
        <span class="t-time">#${ev.received_seq} · ${fmtTime(ev.created_at)}</span>
        <span class="t-tags">
          ${isBase ? `<span class="tag branch-base-tag">基点</span>` : ""}
          <span class="tag ${ev.status}">${STATUS_LABEL[ev.status]}</span>
          <button class="btn mini branch-btn" type="button"
                  data-event-id="${ev.id}" data-index="${i}"
                  title="以此事件为基点建立临时分支">🌿 建分支</button>
        </span>
      </div>
      ${ev.note ? `<div class="t-note">${escapeHtml(ev.note)}</div>` : ""}
    </div>
  `;
  }).join("");

  box.querySelectorAll(".t-event").forEach((el) => {
    el.addEventListener("click", (e) => {
      // 点击"建分支"不触发回放跳转,交给分支逻辑处理。
      if (e.target.closest(".branch-btn")) return;
      stopPlay();
      state.step = Number(el.dataset.index);
      renderReplay();
    });
  });
  box.querySelectorAll(".branch-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      stopPlay();
      onBranchButton(Number(btn.dataset.eventId));
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --------------------------------------------------------------------------- //
// 回放
// --------------------------------------------------------------------------- //
function renderReplay() {
  const total = state.events.length;
  state.step = Math.min(state.step, total - 1);
  if (state.step < 0) state.step = total ? -1 : -1;

  $("#stepCur").textContent = state.step + (state.step >= 0 ? 1 : 0);
  $("#stepTotal").textContent = total;
  $("#prevStep").disabled = state.step < 0;
  $("#nextStep").disabled = state.step >= total - 1;
  $("#playBtn").textContent = state.playing ? "暂停" : "自动播放";

  // 状态板
  const states = statesThrough(Math.max(state.step, -1));
  const stateKeys = Object.keys(states);
  $("#stateView").textContent = stateKeys.length
    ? stateKeys.map((k) =>
        `${k}:\n${JSON.stringify(states[k], null, 2)}`).join("\n\n")
    : "// 提交或播放事件后,这里展示按版本应用后的累积配置";

  // 当前事件详情
  const detail = $("#eventDetail");
  if (state.step < 0) {
    detail.className = "event-detail muted";
    detail.textContent = "尚未播放";
  } else {
    const ev = state.events[state.step];
    detail.className = "event-detail";
    let banner = "";
    if (ev.status === "accepted") {
      banner = `<div class="banner ok">✓ 接受:v${ev.version} 为期望的下一个版本,配置已应用。</div>`;
    } else if (ev.status === "gap") {
      banner = `<div class="banner warn">⚠ 版本跳跃:缺少 v${ev.expected_version}…v${ev.version - 1},` +
               (ev.expected_version === 0
                  ? "从 v0 以外开始。"
                  : `期望 v${ev.expected_version}。` ) +
               ` 事件仍被接受,但版本链不完整。</div>`;
    } else {
      banner = `<div class="banner danger">✗ 冲突:v${ev.version} 晚到,该资源已接受 v${ev.conflict_with},` +
               `此事件被拒绝、配置不变。</div>`;
    }
    detail.innerHTML = `
      <div class="kv"><span>资源:</span> <b>${escapeHtml(ev.resource)}</b></div>
      <div class="kv"><span>版本:</span> v${ev.version} (到达序号 #${ev.received_seq})</div>
      <div class="kv"><span>提交者:</span> ${escapeHtml(ev.author)}</div>
      ${ev.note ? `<div class="kv"><span>备注:</span> ${escapeHtml(ev.note)}</div>` : ""}
      <pre>${escapeHtml(JSON.stringify(ev.payload, null, 2))}</pre>
      ${banner}
    `;
  }

  // 时间线高亮
  document.querySelectorAll(".t-event").forEach((el) => {
    const i = Number(el.dataset.index);
    el.classList.toggle("current", i === state.step);
    el.classList.toggle("dimmed", state.step >= 0 && i > state.step);
  });

  const current = document.querySelector(".t-event.current");
  if (current) current.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function stepNext() {
  if (state.step < state.events.length - 1) {
    state.step++;
    renderReplay();
  } else {
    stopPlay();
  }
}

function startPlay() {
  if (state.step >= state.events.length - 1) state.step = -1;
  state.playing = true;
  renderReplay();
  state.timer = setInterval(stepNext, 1200);
}

function stopPlay() {
  state.playing = false;
  clearInterval(state.timer);
  state.timer = null;
  renderReplay();
}

// --------------------------------------------------------------------------- //
// 分支推演
//   基点:某条真实事件;假设事件只存在浏览器会话中,后端 /api/simulate 不落库。
//   切换基点或资源时清空未提交分支(有假设事件时先确认)。
// --------------------------------------------------------------------------- //
const DIFF_LABEL = { added: "新增", modified: "修改", removed: "删除" };

function findEvent(id) {
  return state.events.find((e) => e.id === id) || null;
}

function discardBranch() {
  state.branch = null;
  renderBranch();
  renderTimeline();
}

// 若已有带假设事件的分支,返回 true 表示用户确认放弃。
function confirmDiscardBranch(reason) {
  if (state.branch && state.branch.events.length) {
    return window.confirm(`当前分支包含 ${state.branch.events.length} 条假设事件,${reason}将清空该分支,是否继续?`);
  }
  return true;
}

async function onBranchButton(eventId) {
  const ev = findEvent(eventId);
  if (!ev) return;

  // 切换基点:清空现有未提交分支。
  if (state.branch && state.branch.baseEventId !== eventId) {
    if (!confirmDiscardBranch("切换基点")) return;
  }
  // "全部资源"视图下建分支:自动切到该资源(按要求切换资源时清空旧分支)。
  if (state.filter !== ev.resource) {
    if (!confirmDiscardBranch("切换资源")) return;
    state.branch = null;
    state.filter = ev.resource;
    state.step = -1;
    await load();
  }

  if (!state.branch || state.branch.baseEventId !== eventId) {
    state.branch = {
      resource: ev.resource,
      baseEventId: eventId,
      events: [],
      result: null,
      busy: false,
      error: "",
    };
    // 回放到基点,让基线状态与"当前配置状态"对齐,便于对照。
    const idx = state.events.findIndex((e) => e.id === eventId);
    if (idx >= 0) state.step = idx;
    renderTimeline();
    renderReplay();
    await runSimulation();
  }
  $("#branchCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runSimulation() {
  const b = state.branch;
  if (!b) return;
  b.busy = true;
  b.error = "";
  renderBranch();
  try {
    b.result = await api.simulate(
      b.baseEventId,
      b.events.map(({ version, author, note, payload }) =>
        ({ version, author, note, payload }))
    );
  } catch (e) {
    b.result = null;
    b.error = e.message;
    // 基点事件已不存在(如数据被外部重置):分支无法继续,直接放弃。
    if (/基点/.test(e.message)) discardBranch();
  } finally {
    b.busy = false;
    renderBranch();
  }
}

function removeHypo(seq) {
  const b = state.branch;
  if (!b) return;
  b.events.splice(seq - 1, 1);
  runSimulation();
}

async function addHypoFromForm(form) {
  const b = state.branch;
  if (!b) return;
  const fd = new FormData(form);
  const version = Number(fd.get("hypoVersion"));
  const payloadRaw = String(fd.get("hypoPayload") || "").trim();
  const msg = $("#hypoMsg");

  if (!Number.isInteger(version) || version < 0) {
    msg.className = "form-msg err";
    msg.textContent = "version 必须是非负整数";
    return;
  }
  let payload;
  try {
    payload = payloadRaw ? JSON.parse(payloadRaw) : {};
  } catch {
    msg.className = "form-msg err";
    msg.textContent = "payload 不是合法 JSON";
    return;
  }

  b.events.push({
    version,
    author: String(fd.get("hypoAuthor") || "").trim() || "anonymous",
    note: String(fd.get("hypoNote") || "").trim(),
    payload,
  });
  msg.className = "form-msg";
  msg.textContent = "";
  await runSimulation();
}

function renderBranch() {
  const card = $("#branchCard");
  const b = state.branch;
  if (!b) {
    card.classList.add("hidden");
    card.innerHTML = "";
    return;
  }
  card.classList.remove("hidden");

  const base = findEvent(b.baseEventId);
  const res = b.result;
  const nextVersion = res
    ? res.next_expected_version
    : (base ? base.version + 1 : 0);

  card.innerHTML = `
    <div class="branch-head">
      <h2>④ 分支推演(临时,仅本浏览器会话)</h2>
      <button class="btn ghost" id="discardBranchBtn">✕ 放弃分支</button>
    </div>
    <p class="branch-meta">
      资源 <b class="mono">${escapeHtml(b.resource)}</b> ·
      基点:<b class="mono">v${base ? base.version : "?"}</b>
      <span class="muted">(到达序号 #${base ? base.received_seq : "?"})</span>
      <button class="btn linkish" id="jumpBaseBtn" type="button">回到基点事件</button>
      — 假设事件按添加顺序重放,复用 accepted / gap / rejected_conflict 规则;<strong>不会写入数据库</strong>。
    </p>

    <div class="diff-board">
      <div class="diff-col">
        <h3>基线最终配置</h3>
        <pre class="state-view">${res ? escapeHtml(JSON.stringify(res.base_config, null, 2)) : "…"}</pre>
      </div>
      <div class="diff-mid">
        <h3>逐键差异</h3>
        ${renderDiffList(res)}
      </div>
      <div class="diff-col">
        <h3>分支最终配置</h3>
        <pre class="state-view">${res ? escapeHtml(JSON.stringify(res.branch_config, null, 2)) : "…"}</pre>
      </div>
    </div>

    <h3 class="hypo-title">假设事件(按添加顺序到达)</h3>
    <div class="hypo-list">
      ${res && res.branch_events.length
        ? res.branch_events.map(renderHypoRow).join("")
        : `<p class="muted">尚无假设事件 —— 分支与基线一致,在下方添加一条试试。</p>`}
    </div>

    <form id="hypoForm" class="hypo-form">
      <div class="hypo-row">
        <label>版本号 <input name="hypoVersion" type="number" min="0" step="1" value="${nextVersion}" required /></label>
        <label class="grow">提交者 <input name="hypoAuthor" placeholder="anonymous" /></label>
        <label class="grow2">备注 <input name="hypoNote" placeholder="可选,如:假设放量失败" /></label>
      </div>
      <label>变更 payload(JSON)
        <textarea name="hypoPayload" rows="4" spellcheck="false">{
  "set": {"key": "value"}
}</textarea>
      </label>
      <div class="hypo-actions">
        <button type="submit" class="btn primary" ${b.busy ? "disabled" : ""}>追加假设事件</button>
        <span class="form-msg" id="hypoMsg">${b.error ? escapeHtml(b.error) : ""}</span>
      </div>
    </form>
  `;
  if (b.error) $("#hypoMsg").className = "form-msg err";

  $("#discardBranchBtn").addEventListener("click", () => {
    if (confirmDiscardBranch("放弃分支")) discardBranch();
  });
  $("#jumpBaseBtn").addEventListener("click", () => {
    const idx = state.events.findIndex((e) => e.id === b.baseEventId);
    if (idx >= 0) { state.step = idx; renderReplay(); }
  });
  card.querySelectorAll(".hypo-del").forEach((btn) => {
    btn.addEventListener("click", () => removeHypo(Number(btn.dataset.seq)));
  });
  card.querySelectorAll(".diff-cause").forEach((chip) => {
    chip.addEventListener("click", () => {
      const row = card.querySelector(
        `.hypo-row-ev[data-seq="${Number(chip.dataset.seq)}"]`
      );
      if (row) {
        row.classList.add("flash");
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => row.classList.remove("flash"), 1200);
      }
    });
  });
  $("#hypoForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await addHypoFromForm(e.target);
  });
}

function renderDiffList(res) {
  if (!res) return `<p class="muted">推演中…</p>`;
  if (!res.diffs.length) {
    return `<div class="diff-empty">✓ 分支与基线最终配置一致,无逐键差异。</div>`;
  }
  const fmt = (v) => escapeHtml(JSON.stringify(v));
  return `
    <table class="diff-table">
      <tbody>
        ${res.diffs.map((d) => `
          <tr class="diff-row ${d.kind}">
            <td><span class="diff-kind ${d.kind}">${DIFF_LABEL[d.kind]}</span></td>
            <td class="mono diff-key">${escapeHtml(d.key)}</td>
            <td class="diff-vals">
              ${d.kind === "added"
                ? `<span class="muted">∅</span> → <span class="ok">${fmt(d.branch_value)}</span>`
                : d.kind === "removed"
                  ? `<span class="danger">${fmt(d.base_value)}</span> → <span class="muted">∅</span>`
                  : `<span class="warn">${fmt(d.base_value)}</span> → <span class="ok">${fmt(d.branch_value)}</span>`}
            </td>
            <td>${d.caused_by
              ? `<button type="button" class="btn mini diff-cause" data-seq="${d.caused_by.branch_seq}">⮞ ${escapeHtml(d.caused_by.label)}</button>`
              : ""}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function renderHypoRow(ev) {
  let reason = "";
  if (ev.status === "accepted") {
    reason = `<span class="banner ok">✓ 接受:v${ev.version} 为期望的下一个版本。</span>`;
  } else if (ev.status === "gap") {
    reason = `<span class="banner warn">⚠ 版本跳跃:期望 v${ev.expected_version},实际 v${ev.version},仍被接受。</span>`;
  } else {
    reason = `<span class="banner danger">✗ 冲突:v${ev.version} 晚到,该资源已接受 v${ev.conflict_with},被拒绝、配置不变。</span>`;
  }
  return `
    <div class="hypo-row-ev ${ev.status}" data-seq="${ev.branch_seq}">
      <div class="hypo-head">
        <span class="hypo-seq">#${ev.branch_seq}</span>
        <span class="t-version">v${ev.version}</span>
        <span class="t-author">@${escapeHtml(ev.author)}</span>
        ${ev.note ? `<span class="hypo-note">${escapeHtml(ev.note)}</span>` : ""}
        <span class="t-tags">
          <span class="tag ${ev.status}">${STATUS_LABEL[ev.status]}</span>
          <button type="button" class="btn mini hypo-del" data-seq="${ev.branch_seq}">删除</button>
        </span>
      </div>
      <pre class="hypo-payload">${escapeHtml(JSON.stringify(ev.payload, null, 2))}</pre>
      ${reason}
    </div>`;
}

// --------------------------------------------------------------------------- //
// 数据加载 / 事件绑定
// --------------------------------------------------------------------------- //
async function load() {
  try {
    const data = await api.list(state.filter);
    state.events = data.events;
    state.resources = data.resources;
    if (state.step > state.events.length - 1) state.step = -1;
    // 数据刷新后基点事件可能已失效(被外部删除/资源不再匹配):清空分支。
    if (state.branch &&
        (state.filter !== state.branch.resource ||
         !findEvent(state.branch.baseEventId))) {
      state.branch = null;
    }
    renderAll();
  } catch (e) {
    alert(e.message);
  }
}

function renderAll() {
  renderResources();
  renderTopStats();
  renderTimeline();
  renderReplay();
  renderBranch();
}

$("#nextStep").addEventListener("click", () => { stopPlay(); stepNext(); });
$("#prevStep").addEventListener("click", () => {
  stopPlay();
  if (state.step >= 0) { state.step--; renderReplay(); }
});
$("#playBtn").addEventListener("click", () => (state.playing ? stopPlay() : startPlay()));
$("#resetReplay").addEventListener("click", () => { stopPlay(); state.step = -1; renderReplay(); });
$("#resetFilter").addEventListener("click", () => {
  if (!state.filter) return;
  if (state.branch && !confirmDiscardBranch("切换资源")) return;
  state.filter = "";
  state.step = -1;
  state.branch = null;
  load();
});
$("#exportBtn").addEventListener("click", () => {
  const qs = state.filter ? `?resource=${encodeURIComponent(state.filter)}` : "";
  window.location.href = `/api/export${qs}`;
});

$("#eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#formMsg");
  const fd = new FormData(e.target);
  const resource = String(fd.get("resource") || "").trim();
  const version = Number(fd.get("version"));
  const payloadRaw = String(fd.get("payload") || "").trim();

  let payload;
  try {
    payload = payloadRaw ? JSON.parse(payloadRaw) : {};
  } catch {
    msg.className = "form-msg err";
    msg.textContent = "payload 不是合法 JSON";
    return;
  }

  try {
    const data = await api.create({
      resource,
      version,
      author: String(fd.get("author") || "").trim(),
      note: String(fd.get("note") || "").trim(),
      payload,
    });
    msg.className = "form-msg ok";
    const st = data.event.status;
    msg.textContent = st === "rejected_conflict"
      ? `已记录,但检测到冲突(v${version} 晚到),事件被拒绝。`
      : st === "gap"
        ? `已记录:v${version} 与版本链之间存在跳跃,请注意缺失版本。`
        : `已接受 v${version}。`;
    state.resources = data.resources;
    state.filter = resource;   // 自动切到刚提交的资源便于回放
    state.step = -1;
    state.branch = null;       // 新真实事件改变到达序列,清空未提交分支
    await load();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = err.message;
  }
});

load();
