/* 配置变更回放台 - 原生 JS,无任何框架依赖。 */

const state = {
  events: [],
  resources: [],
  filter: "",        // 资源名,空串表示全部
  step: -1,          // 回放到第几个事件(-1 = 未开始)
  playing: false,
  timer: null,
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
      state.filter = decodeURIComponent(el.dataset.resource);
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

  box.innerHTML = state.events.map((ev, i) => `
    <div class="t-event ${ev.status}" data-index="${i}">
      <div class="t-head">
        <span class="t-version">v${ev.version}</span>
        <span class="t-resource">${ev.resource}</span>
        <span class="t-author">@${ev.author}</span>
        <span class="t-time">#${ev.received_seq} · ${fmtTime(ev.created_at)}</span>
        <span class="t-tags"><span class="tag ${ev.status}">${STATUS_LABEL[ev.status]}</span></span>
      </div>
      ${ev.note ? `<div class="t-note">${escapeHtml(ev.note)}</div>` : ""}
    </div>
  `).join("");

  box.querySelectorAll(".t-event").forEach((el) => {
    el.addEventListener("click", () => {
      stopPlay();
      state.step = Number(el.dataset.index);
      renderReplay();
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
// 数据加载 / 事件绑定
// --------------------------------------------------------------------------- //
async function load() {
  try {
    const data = await api.list(state.filter);
    state.events = data.events;
    state.resources = data.resources;
    if (state.step > state.events.length - 1) state.step = -1;
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
}

$("#nextStep").addEventListener("click", () => { stopPlay(); stepNext(); });
$("#prevStep").addEventListener("click", () => {
  stopPlay();
  if (state.step >= 0) { state.step--; renderReplay(); }
});
$("#playBtn").addEventListener("click", () => (state.playing ? stopPlay() : startPlay()));
$("#resetReplay").addEventListener("click", () => { stopPlay(); state.step = -1; renderReplay(); });
$("#resetFilter").addEventListener("click", () => { state.filter = ""; state.step = -1; load(); });
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
    await load();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = err.message;
  }
});

load();
