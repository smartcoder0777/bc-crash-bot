const socket = io();

const el = (id) => document.getElementById(id);

function fillForm(cfg) {
  const form = el("cfgForm");
  for (const [k, v] of Object.entries(cfg)) {
    if (form.elements[k] != null) form.elements[k].value = v;
  }
  if (cfg.site_url && form.elements.site_url) {
    form.elements.site_url.value = cfg.site_url;
  }
}

function render(s, { syncForm = false } = {}) {
  el("liveMult").textContent =
    s.live_multiplier != null ? `${Number(s.live_multiplier).toFixed(2)}x` : "—";
  const mode = s.mode || "idle";
  const modeEl = el("mode");
  modeEl.textContent = mode;
  modeEl.className = `pill ${mode}`;

  el("stake").textContent =
    mode === "recovery"
      ? String(s.recovery_stake)
      : String(s.current_stake);
  const pnl = Number(s.session_pnl || 0);
  el("pnl").textContent = pnl.toFixed(4);
  el("pnl").className = `value ${pnl >= 0 ? "pnl-pos" : "pnl-neg"}`;

  el("botRunning").textContent = s.bot_running ? "RUNNING" : "off";
  el("message").textContent = s.message || "—";
  el("siteMessage").textContent = s.site_message || "—";
  el("lossesStreak").textContent = s.consecutive_losses ?? 0;
  el("restLeft").textContent = s.rest_remaining ?? 0;
  el("recLeft").textContent = s.recovery_left ?? 0;
  el("wl").textContent = `${s.wins ?? 0} / ${s.losses ?? 0}`;
  el("bets").textContent = s.bets_placed ?? 0;
  el("lastResult").textContent = s.last_result || "—";
  el("lastCrash").textContent =
    s.last_crash != null ? `${Number(s.last_crash).toFixed(2)}x` : "—";

  const tbody = el("history");
  tbody.innerHTML = "";
  (s.history || []).slice().reverse().forEach((h) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="${h.result}">${h.result}</td>
      <td>${h.stake}</td>
      <td class="${h.profit >= 0 ? "win" : "lose"}">${h.profit}</td>
      <td>${h.crash != null ? h.crash : "—"}</td>`;
    tbody.appendChild(tr);
  });

  if (syncForm && s.config) fillForm(s.config);
}

socket.on("status", (s) => render(s));
socket.on("connect", () => socket.emit("request_status"));

fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    render(s, { syncForm: true });
  });

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => fillForm(cfg));

el("btnStart").onclick = async () => {
  await fetch("/api/start", { method: "POST" });
};
el("btnStop").onclick = async () => {
  await fetch("/api/stop", { method: "POST" });
};
el("btnReset").onclick = async () => {
  const r = await fetch("/api/reset", { method: "POST" });
  const data = await r.json();
  if (data.status) render(data.status);
};

el("cfgForm").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  const r = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  el("saveMsg").textContent = data.ok ? "Settings saved." : data.error || "Save failed";
  if (data.config) fillForm(data.config);
};
