/* 配置变更回放台 - 原生 JS,无任何框架依赖。 */

const state = {
  events: [],
  resources: [],
  filter: "",        // 资源名,空串表示全部
  step: -1,          // 回放到第几个事件(-1 = 未开始)
  playing: false,
  timer: null,
  // 分支推演(纯浏览器会话内状态,刷新即消失)
  sim: {
    active: false,
    resource: "",
    baseEventId: null,   // null = 从空状态起推演
    hypotheses: [],      // [{version, author, note, payload}]
    result: null,        // 最近一次 /api/simulate 返回
  },
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
  async simulate(body) {
    const r = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  let next = clone(prev ?? {});
  if (payload && typeof payload === "object" && !Array.isArray(payload) &&
      ("set" in payload || "remove" in payload)) {
    if (typeof next !== "object" || Array.isArray(next)) next = {};
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
      const resource = decodeURIComponent(el.dataset.resource);
      selectResource(resource);
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

  const baseId = state.sim.active ? state.sim.baseEventId : null;
  box.innerHTML = state.events.map((ev, i) => `
    <div class="t-event ${ev.status} ${baseId === ev.id ? "branch-base" : ""}" data-index="${i}">
      <div class="t-head">
        <span class="t-version">v${ev.version}</span>
        <span class="t-resource">${ev.resource}</span>
        <span class="t-author">@${ev.author}</span>
        <span class="t-time">#${ev.received_seq} · ${fmtTime(ev.created_at)}</span>
        <span class="t-tags">
          <button class="branch-chip" type="button" data-id="${ev.id}"
                  data-resource="${encodeURIComponent(ev.resource)}"
                  title="以该事件(含)之后的状态为基点建立临时分支">⑂ 建分支</button>
          <span class="tag ${ev.status}">${STATUS_LABEL[ev.status]}</span>
        </span>
      </div>
      ${ev.note ? `<div class="t-note">${escapeHtml(ev.note)}</div>` : ""}
    </div>
  `).join("");

  box.querySelectorAll(".t-event").forEach((el) => {
    el.addEventListener("click", (e) => {
      // 点击"建分支"按钮不触发回放跳转
      if (e.target.closest(".branch-chip")) return;
      stopPlay();
      state.step = Number(el.dataset.index);
      renderReplay();
    });
  });
  box.querySelectorAll(".branch-chip").forEach((el) => {
    el.addEventListener("click", () => {
      startBranch(Number(el.dataset.id), decodeURIComponent(el.dataset.resource));
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
    detail.innerHTML = `
      <div class="kv"><span>资源:</span> <b>${escapeHtml(ev.resource)}</b></div>
      <div class="kv"><span>版本:</span> v${ev.version} (到达序号 #${ev.received_seq})</div>
      <div class="kv"><span>提交者:</span> ${escapeHtml(ev.author)}</div>
      ${ev.note ? `<div class="kv"><span>备注:</span> ${escapeHtml(ev.note)}</div>` : ""}
      <pre>${escapeHtml(JSON.stringify(ev.payload, null, 2))}</pre>
      ${statusBanner(ev)}
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

function statusBanner(ev) {
  if (ev.status === "accepted") {
    return `<div class="banner ok">✓ 接受:v${ev.version} 为期望的下一个版本,配置已应用。</div>`;
  }
  if (ev.status === "gap") {
    return `<div class="banner warn">⚠ 版本跳跃:缺少 v${ev.expected_version}…v${ev.version - 1},` +
           (ev.expected_version === 0
              ? "从 v0 以外开始。"
              : `期望 v${ev.expected_version}。` ) +
           ` 事件仍被接受,但版本链不完整。</div>`;
  }
  return `<div class="banner danger">✗ 冲突:v${ev.version} 晚到,该资源已接受 v${ev.conflict_with},` +
         `此事件被拒绝、配置不变。</div>`;
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
// --------------------------------------------------------------------------- //
async function runSimulation() {
  const sim = state.sim;
  sim.result = await api.simulate({
    resource: sim.resource,
    base_event_id: sim.baseEventId,
    events: sim.hypotheses,
  });
  renderBranch();
}

async function startBranch(baseEventId, resource) {
  const sim = state.sim;
  // 切换基点或资源都会丢弃未提交假设事件,先确认。
  if (sim.active &&
      (sim.resource !== resource || sim.baseEventId !== baseEventId) &&
      sim.hypotheses.length &&
      !confirm("切换基点/资源会清空当前分支尚未提交的假设事件,确定继续?")) {
    return;
  }
  // 基点事件可能属于另一个资源(全局视图下):先切到该资源,并清空旧分支。
  if (state.filter !== resource) {
    state.filter = resource;
    state.step = -1;
    if (sim.active) {
      sim.active = false;
      sim.resource = "";
      sim.baseEventId = null;
      sim.hypotheses = [];
      sim.result = null;
    }
    await load();
  }
  sim.active = true;
  sim.resource = resource;
  sim.baseEventId = baseEventId;
  sim.hypotheses = [];
  sim.result = null;
  await runSimulation();
  $("#branchPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function clearBranch() {
  state.sim = { active: false, resource: "", baseEventId: null, hypotheses: [], result: null };
  renderTimeline();
  renderBranch();
}

async function addHypothesis(e) {
  e.preventDefault();
  const form = $("#hypForm");
  const msg = $("#hypMsg");
  const version = Number(new FormData(form).get("version"));
  const payloadRaw = String(new FormData(form).get("payload") || "").trim();
  const author = String(new FormData(form).get("author") || "").trim();
  const note = String(new FormData(form).get("note") || "").trim();

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

  state.sim.hypotheses.push({ version, author, note, payload });
  form.reset();
  form.querySelector('[name="payload"]').value = '{\n  "set": {"key": "value"}\n}';
  msg.className = "form-msg";
  msg.textContent = "";
  try {
    await runSimulation();
  } catch (err) {
    state.sim.hypotheses.pop();
    renderBranch();
    msg.className = "form-msg err";
    msg.textContent = err.message;
  }
}

async function removeHypothesis(index) {
  state.sim.hypotheses.splice(index, 1);
  try {
    await runSimulation();
  } catch (err) {
    alert(err.message);
  }
}

async function switchBase(baseEventId) {
  // 切换基点 = 丢弃当前未提交分支,在新基点重开。
  if (state.sim.hypotheses.length &&
      !confirm("切换基点会清空当前分支尚未提交的假设事件,确定继续?")) {
    return;
  }
  state.sim.baseEventId = baseEventId;
  state.sim.hypotheses = [];
  try {
    await runSimulation();
  } catch (err) {
    alert(err.message);
  }
}

async function selectResource(resource) {
  // 切换资源(或回到全部)时清空未提交分支。
  if (state.sim.active && state.sim.resource !== resource) {
    await clearBranch();
  }
  state.filter = resource;
  state.step = -1;
  load();
}

function baseLabel() {
  const { baseEventId, result } = state.sim;
  if (baseEventId === null) return "空状态(该资源尚无事件时)";
  const be = result && result.base_event;
  return be
    ? `#${be.received_seq} · v${be.version}`
    : `事件 #${baseEventId}`;
}

function renderBranch() {
  const box = $("#branchPanel");
  const sim = state.sim;

  if (!sim.active) {
    renderTimeline(); // 刷新基点高亮(去掉旧标记)
    box.innerHTML = `
      <p class="muted">
        ${state.filter
          ? `在上方时间线的任意事件上点击「⑂ 建分支」,或直接从空状态开始推演 <b>${escapeHtml(state.filter)}</b>。`
          : "先在左侧选择单个资源(分支推演针对单个资源)。"}
      </p>
      ${state.filter
        ? `<button class="btn" id="emptyBaseBtn" type="button">从空状态对 ${escapeHtml(state.filter)} 建分支</button>`
        : ""}
    `;
    const emptyBtn = $("#emptyBaseBtn");
    if (emptyBtn) emptyBtn.addEventListener("click", () => startBranch(null, state.filter));
    return;
  }

  const res = sim.result;
  if (!res) {
    box.innerHTML = `<p class="muted">推演中…</p>`;
    return;
  }

  box.innerHTML = `
    <div class="branch-meta">
      <div>
        <span class="t-resource">${escapeHtml(res.resource)}</span>
        的临时分支 · 基点:
        <b>${escapeHtml(baseLabel())}</b>
      </div>
      <div class="branch-meta-btns">
        <button class="btn icon" id="emptyBaseSwitch" type="button"
                title="把基点切到空状态(会清空假设事件)">基点→空</button>
        <button class="btn ghost" id="abandonBranch" type="button">放弃分支</button>
      </div>
    </div>

    <form id="hypForm" class="hyp-form">
      <div class="hyp-row">
        <label>版本号 <input name="version" type="number" min="0" step="1" required /></label>
        <label>提交者 <input name="author" placeholder="anonymous" /></label>
        <label>备注 <input name="note" placeholder="可选" /></label>
      </div>
      <label>假设变更 payload(JSON,仅存于浏览器会话)
        <textarea name="payload" rows="4" spellcheck="false">{
  "set": {"key": "value"}
}</textarea>
      </label>
      <button type="submit" class="btn primary narrow">＋ 添加假设事件</button>
      <p class="form-msg" id="hypMsg"></p>
    </form>

    <div id="hypList" class="hyp-list"></div>

    <div class="diff-grid">
      <div class="state-col">
        <h3>基线最终配置 <span class="muted">@基点</span></h3>
        <pre class="state-view small">${escapeHtml(JSON.stringify(res.baseline_config, null, 2))}</pre>
      </div>
      <div class="state-col">
        <h3>分支最终配置 <span class="muted">含假设事件</span></h3>
        <pre class="state-view small">${escapeHtml(JSON.stringify(res.branch_config, null, 2))}</pre>
      </div>
    </div>

    <div id="diffView" class="diff-view"></div>
  `;

  $("#hypForm").addEventListener("submit", addHypothesis);
  $("#abandonBranch").addEventListener("click", clearBranch);
  $("#emptyBaseSwitch").addEventListener("click", () => switchBase(null));
  renderHypList();
  renderDiff();
  renderTimeline(); // 刷新基点高亮
}

function renderHypList() {
  const box = $("#hypList");
  const res = state.sim.result;
  if (!res.branch_events.length) {
    box.innerHTML = `<p class="muted hyp-empty">还没有假设事件,在上方表单添加。分支事件按添加顺序到达。</p>`;
    return;
  }
  box.innerHTML = res.branch_events.map((ev, i) => {
    const keys = ev.changes.keys
      .map((k) => `<span class="ckey">${k === "" ? "(整体)" : escapeHtml(k)}</span>`)
      .join("");
    return `
    <div class="hyp-item ${ev.status}" data-branch-index="${i}">
      <div class="t-head">
        <span class="hyp-order">#${i + 1}</span>
        <span class="t-version">v${ev.version}</span>
        <span class="t-author">@${escapeHtml(ev.author)}</span>
        <span class="tag ${ev.status}">${STATUS_LABEL[ev.status]}</span>
        <span class="hyp-keys">${keys}</span>
        <button class="btn icon hyp-del" type="button" data-index="${i}"
                title="移除该假设事件">✕</button>
      </div>
      ${ev.note ? `<div class="t-note">${escapeHtml(ev.note)}</div>` : ""}
      ${ev.status === "rejected_conflict"
        ? `<div class="hyp-reason">与已接受的 v${ev.conflict_with} 冲突,被拒绝,配置不变。</div>`
        : ev.status === "gap"
          ? `<div class="hyp-reason warn-text">版本跳跃:缺少 v${ev.expected_version}…v${ev.version - 1},仍被接受。</div>`
          : ""}
    </div>`;
  }).join("");

  box.querySelectorAll(".hyp-del").forEach((el) => {
    el.addEventListener("click", () => removeHypothesis(Number(el.dataset.index)));
  });
}

function renderDiff() {
  const box = $("#diffView");
  const { diff, caused_by: causes } = state.sim.result;
  const total = diff.added.length + diff.modified.length + diff.removed.length;

  if (!total) {
    box.innerHTML = `<div class="banner ok">分支与基线最终配置一致,没有差异。</div>`;
    return;
  }

  const causeChip = (key) => {
    const c = causes[key];
    if (!c) return "";
    const lbl = STATUS_LABEL[c.status];
    return ` <button type="button" class="cause-chip ${c.status}"
              data-branch-index="${c.branch_index}"
              title="定位到导致该差异的假设事件">由 #${c.branch_index + 1} · v${c.version} · ${lbl} 导致 →</button>`;
  };

  const sections = [];
  if (diff.added.length) {
    sections.push(`<div class="diff-sec"><h4 class="d-added">新增 ${diff.added.length}</h4>` +
      diff.added.map((d) => `
        <div class="diff-row">
          <code>${d.key === "" ? "(整体)" : escapeHtml(d.key)}</code>
          <span class="diff-val">${escapeHtml(JSON.stringify(d.value))}</span>
          ${causeChip(d.key)}
        </div>`).join("") + `</div>`);
  }
  if (diff.modified.length) {
    sections.push(`<div class="diff-sec"><h4 class="d-modified">修改 ${diff.modified.length}</h4>` +
      diff.modified.map((d) => `
        <div class="diff-row">
          <code>${d.key === "" ? "(整体)" : escapeHtml(d.key)}</code>
          <span class="diff-val base">${escapeHtml(JSON.stringify(d.base_value))}</span>
          <span class="diff-arrow">→</span>
          <span class="diff-val branch">${escapeHtml(JSON.stringify(d.branch_value))}</span>
          ${causeChip(d.key)}
        </div>`).join("") + `</div>`);
  }
  if (diff.removed.length) {
    sections.push(`<div class="diff-sec"><h4 class="d-removed">删除 ${diff.removed.length}</h4>` +
      diff.removed.map((d) => `
        <div class="diff-row">
          <code>${d.key === "" ? "(整体)" : escapeHtml(d.key)}</code>
          <span class="diff-val base">${escapeHtml(JSON.stringify(d.value))}</span>
          <span class="diff-arrow">→</span>
          <span class="diff-val muted">∅</span>
          ${causeChip(d.key)}
        </div>`).join("") + `</div>`);
  }

  box.innerHTML = `<h3>逐键差异(${total})<span class="muted"> · 点击右侧标签定位导致差异的事件</span></h3>` +
    sections.join("");

  box.querySelectorAll(".cause-chip").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.branchIndex);
      const target = document.querySelector(`.hyp-item[data-branch-index="${idx}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.remove("flash");
        void target.offsetWidth;          // 重置动画以便重复触发
        target.classList.add("flash");
      }
    });
  });
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
    renderResources();
    renderTopStats();
    renderTimeline();
    renderReplay();
    renderBranch();
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
$("#resetFilter").addEventListener("click", () => selectResource(""));
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
    if (state.sim.active && state.sim.resource === resource) {
      // 该资源有新真实事件落库,分支基点视图已变化,清空未提交分支。
      await clearBranch();
    }
    await selectResource(resource);   // 自动切到刚提交的资源;切资源会清空分支
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = err.message;
  }
});

load();
