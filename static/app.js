const socket = io();
const PAGE_SIZE = 100;

const el = (id) => document.getElementById(id);

let historyCache = [];
let page = 1;
let settingsDirty = false;

function fillForm(cfg) {
  const form = el("cfgForm");
  for (const [k, v] of Object.entries(cfg)) {
    if (form.elements[k] != null) form.elements[k].value = v;
  }
  if (cfg.site_url && form.elements.site_url) {
    form.elements.site_url.value = cfg.site_url;
  }
}

function setSaveClean() {
  settingsDirty = false;
  const btn = el("btnSave");
  btn.textContent = "Saved";
  btn.disabled = true;
}

function setSaveDirty() {
  settingsDirty = true;
  const btn = el("btnSave");
  btn.textContent = "Save settings";
  btn.disabled = false;
}

function updateBetButtons(s) {
  const startBtn = el("btnStartBet");
  const stopBtn = el("btnStopBet");
  const connected = !!s.bot_running;
  const betting = !!s.betting_enabled;

  if (!connected) {
    startBtn.textContent = "Start bet";
    stopBtn.textContent = "Stop bet";
    startBtn.disabled = true;
    stopBtn.disabled = true;
    return;
  }

  if (betting) {
    startBtn.textContent = "Started";
    startBtn.disabled = true;
    stopBtn.textContent = "Stop bet";
    stopBtn.disabled = false;
  } else {
    startBtn.textContent = "Start bet";
    startBtn.disabled = false;
    stopBtn.textContent = "Stopped";
    stopBtn.disabled = true;
  }
}

function totalPages() {
  return Math.max(1, Math.ceil(historyCache.length / PAGE_SIZE));
}

function renderHistoryPage() {
  const pages = totalPages();
  if (page > pages) page = pages;
  if (page < 1) page = 1;

  const newestFirst = historyCache.slice().reverse();
  const start = (page - 1) * PAGE_SIZE;
  const slice = newestFirst.slice(start, start + PAGE_SIZE);

  const tbody = el("history");
  tbody.innerHTML = "";
  slice.forEach((h, i) => {
    const roundNo = historyCache.length - start - i;
    const tr = document.createElement("tr");
    tr.className = h.result === "win" ? "row-win" : "row-lose";
    const profitClass = h.result === "win" ? "win" : "lose";
    tr.innerHTML = `
      <td>${roundNo}</td>
      <td class="${profitClass}">${h.result}</td>
      <td>${h.stake}</td>
      <td class="${profitClass}">${h.profit}</td>
      <td>${h.crash != null ? h.crash : "—"}</td>`;
    tbody.appendChild(tr);
  });

  el("pageInfo").textContent = `Page ${page} / ${pages} (${historyCache.length} rounds)`;
  el("prevPage").disabled = page <= 1;
  el("nextPage").disabled = page >= pages;
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

  const won = Number(s.total_won || 0);
  const lost = Number(s.total_lost || 0);
  const pnl = Number(s.session_pnl || 0);
  const startBal = Number(s.start_balance || 0);
  const curBal = Number(
    s.current_balance != null ? s.current_balance : startBal + pnl
  );
  el("startBalance").textContent = startBal.toFixed(4);
  el("currentBalance").textContent = curBal.toFixed(4);
  el("currentBalance").className = `value ${curBal >= startBal ? "win" : "lose"}`;
  el("totalWon").textContent = won.toFixed(4);
  el("totalLost").textContent = lost.toFixed(4);
  el("pnl").textContent = pnl.toFixed(4);
  el("pnl").className = `value ${pnl >= 0 ? "win" : "lose"}`;

  el("wlTop").textContent = `${s.wins ?? 0} / ${s.losses ?? 0}`;
  el("botRunning").textContent = s.bot_running ? "RUNNING" : "off";
  el("bettingState").textContent = s.betting_enabled ? "ON" : "off";
  el("bettingState").className = s.betting_enabled ? "win" : "lose";
  updateBetButtons(s);
  el("btnContinue").disabled = !s.awaiting_login;
  if (s.awaiting_login) {
    el("btnContinue").classList.add("pulse");
  } else {
    el("btnContinue").classList.remove("pulse");
  }
  el("message").textContent = s.message || "—";
  el("siteMessage").textContent = s.site_message || "—";
  el("lossesStreak").textContent = s.consecutive_losses ?? 0;
  el("restLeft").textContent = s.rest_remaining ?? 0;
  el("recLeft").textContent = s.recovery_left ?? 0;
  el("wl").textContent = `${s.wins ?? 0} / ${s.losses ?? 0}`;
  el("bets").textContent = s.bets_placed ?? 0;

  const last = s.last_result || "—";
  el("lastResult").textContent = last;
  el("lastResult").className = last === "win" ? "win" : last === "lose" ? "lose" : "";

  el("lastCrash").textContent =
    s.last_crash != null ? `${Number(s.last_crash).toFixed(2)}x` : "—";

  historyCache = s.history || [];
  renderHistoryPage();

  if (syncForm && s.config) {
    fillForm(s.config);
    setSaveClean();
  }
}

el("prevPage").onclick = () => {
  page -= 1;
  renderHistoryPage();
};
el("nextPage").onclick = () => {
  page += 1;
  renderHistoryPage();
};

socket.on("status", (s) => render(s));
socket.on("connect", () => socket.emit("request_status"));

fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    render(s, { syncForm: true });
  });

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    fillForm(cfg);
    setSaveClean();
  });

el("cfgForm").addEventListener("input", () => setSaveDirty());
el("cfgForm").addEventListener("change", () => setSaveDirty());

el("btnLoginChrome").onclick = async () => {
  const r = await fetch("/api/open-login", { method: "POST" });
  const data = await r.json();
  if (!data.ok) alert(data.error || "Could not open Chrome");
};
el("btnStart").onclick = async () => {
  await fetch("/api/start", { method: "POST" });
};
el("btnContinue").onclick = async () => {
  await fetch("/api/confirm-login", { method: "POST" });
};
el("btnStop").onclick = async () => {
  await fetch("/api/stop", { method: "POST" });
};
el("btnStartBet").onclick = async () => {
  const r = await fetch("/api/betting/start", { method: "POST" });
  const data = await r.json();
  if (!data.ok) alert(data.error || "Cannot start betting");
};
el("btnStopBet").onclick = async () => {
  await fetch("/api/betting/stop", { method: "POST" });
};
el("btnReset").onclick = async () => {
  page = 1;
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
  if (data.ok) {
    if (data.config) fillForm(data.config);
    setSaveClean();
  }
};
