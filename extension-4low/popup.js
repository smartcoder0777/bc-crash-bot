document.getElementById("extVer").textContent =
  "v" + chrome.runtime.getManifest().version;

const KEYS = [
  "stake",
  "cashout",
  "low_below",
  "streak_needed",
  "skip_on_lose",
  "stop_loss",
];

function isCrashUrl(url) {
  return /bc\.game|bcmail2\.com/i.test(url || "");
}

async function crashTab() {
  const queries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { currentWindow: true },
    {},
  ];
  for (const q of queries) {
    const tabs = await chrome.tabs.query(q);
    const hit = tabs.find((t) => isCrashUrl(t.url));
    if (hit) return hit;
  }
  return null;
}

async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_STATUS" });
  } catch {
    return null;
  }
}

async function injectFiles(tabId, allFrames) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames },
    files: ["strategy.js", "content.js"],
  });
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames },
      files: ["overlay.css"],
    });
  } catch (_) {}
}

async function injectBot(tabId) {
  try {
    await injectFiles(tabId, true);
  } catch (_) {
    await injectFiles(tabId, false);
  }
}

async function send(type, extra = {}) {
  const tab = await crashTab();
  if (!tab) {
    document.getElementById("pageHint").textContent =
      "Open bc.game or bcmail2.com crash page first.";
    document.getElementById("msg").textContent =
      "Go to the crash game tab, then click the extension again.";
    return null;
  }
  document.getElementById("pageHint").textContent = tab.url;

  let status = await ping(tab.id);
  if (!status) {
    document.getElementById("msg").textContent = "Connecting to crash tab…";
    try {
      await injectBot(tab.id);
      await new Promise((r) => setTimeout(r, 200));
      status = await ping(tab.id);
    } catch (err) {
      document.getElementById("msg").textContent =
        "Could not attach: " + (err && err.message ? err.message : err);
      return null;
    }
  }
  if (!status) {
    document.getElementById("msg").textContent =
      "Still not connected. Reload the extension on chrome://extensions, refresh the crash page, then try Start again.";
    return null;
  }
  if (type === "GET_STATUS") return status;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...extra });
  } catch (err) {
    document.getElementById("msg").textContent =
      "Button failed: " + (err && err.message ? err.message : err);
    return null;
  }
}

let formReady = false;

function fillForm(cfg) {
  if (!cfg) return;
  const form = document.getElementById("cfg");
  if (form.contains(document.activeElement)) return;
  KEYS.forEach((k) => {
    if (cfg[k] != null && form.elements[k]) form.elements[k].value = cfg[k];
  });
}

function fmtAmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(4);
}

function fmtStake(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return String(v);
}

function renderLog(s) {
  const won = document.getElementById("logWon");
  const lost = document.getElementById("logLost");
  const pnl = document.getElementById("logPnl");
  won.textContent = Number(s.total_won || 0).toFixed(4);
  lost.textContent = Number(s.total_lost || 0).toFixed(4);
  const pl = Number(s.session_pnl || 0);
  pnl.textContent = fmtAmt(pl);
  pnl.className = pl >= 0 ? "win" : "lose";

  const box = document.getElementById("logList");
  const rows = Array.isArray(s.bet_log) ? s.bet_log : [];
  if (!rows.length) {
    box.innerHTML = `<div class="log-empty">No bets yet. Start on the Bot tab.</div>`;
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 28;
  box.innerHTML = rows
    .slice()
    .reverse()
    .map((r) => {
      const kind = r.kind || "bet";
      const label = kind === "win" ? "WIN" : kind === "lose" ? "LOSE" : "BET";
      const amount =
        kind === "bet"
          ? `@ ${r.cashout ?? "—"}x`
          : fmtAmt(r.profit);
      const crash = r.crash != null ? `${r.crash}x` : "—";
      return `<div class="log-row ${kind}">
        <span>${r.t || ""}</span>
        <span class="kind">${label}</span>
        <span>${fmtStake(r.stake)}</span>
        <span class="${kind === "win" ? "win" : kind === "lose" ? "lose" : ""}">${amount}</span>
        <span>${crash}</span>
      </div>`;
    })
    .join("");
  if (atBottom) box.scrollTop = 0;
}

function render(s, { syncForm = false } = {}) {
  if (!s) return;
  document.getElementById("mode").textContent = s.mode || "idle";
  const betting = document.getElementById("betting");
  betting.textContent = s.betting_enabled ? "ON" : "off";
  betting.className = s.betting_enabled ? "win" : "lose";
  document.getElementById("streak").textContent =
    `${s.low_streak ?? 0} / ${s.streak_needed ?? 4}`;
  document.getElementById("skip").textContent = String(s.skip_remaining ?? 0);
  document.getElementById("stake").textContent = s.pending_stake != null
    ? String(s.pending_stake)
    : String(s.current_stake);
  const pnl = document.getElementById("pnl");
  pnl.textContent = Number(s.session_pnl || 0).toFixed(4);
  pnl.className = s.session_pnl >= 0 ? "win" : "lose";
  document.getElementById("wl").textContent = `${s.wins ?? 0} / ${s.losses ?? 0}`;
  document.getElementById("bal").textContent =
    s.current_balance != null ? Number(s.current_balance).toFixed(4) : "—";
  document.getElementById("msg").textContent = s.site_message || s.message || "—";
  renderLog(s);
  if (syncForm && s.config) {
    fillForm(s.config);
    formReady = true;
  } else if (!formReady && s.config) {
    fillForm(s.config);
    formReady = true;
  }
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const id = btn.getAttribute("data-tab");
    document.getElementById("panelBot").classList.toggle("hidden", id !== "bot");
    document.getElementById("panelLog").classList.toggle("hidden", id !== "log");
  };
});

document.getElementById("btnStart").onclick = async () => {
  document.getElementById("msg").textContent = "Starting…";
  render(await send("START_BET"));
};
document.getElementById("btnStop").onclick = async () => {
  render(await send("STOP_BET"));
};
document.getElementById("btnReset").onclick = async () => {
  render(await send("RESET"));
};
document.getElementById("cfg").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const config = {};
  KEYS.forEach((k) => {
    const v = form.elements[k].value;
    config[k] = k === "streak_needed" || k === "skip_on_lose"
      ? parseInt(v, 10)
      : parseFloat(v);
  });
  render(await send("UPDATE_CONFIG", { config }), { syncForm: true });
};

async function refresh() {
  render(await send("GET_STATUS"));
}
refresh().then(() => {
  chrome.storage.local.get("config", (data) => {
    if (data.config) fillForm(data.config);
  });
});
setInterval(refresh, 1000);
