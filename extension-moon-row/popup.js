document.getElementById("extVer").textContent =
  "v" + chrome.runtime.getManifest().version;

const KEYS = [
  "stake",
  "cashout",
  "martingale",
  "max_attempts",
  "moon_min",
  "cat_min",
  "pos2_max_first",
  "filter_rows",
  "stop_loss",
];

const INT_KEYS = ["max_attempts", "filter_rows"];

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

async function injectBot(tabId) {
  const files = ["inject.js", "strategy-moon-row.js", "content.js"];
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["inject.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["strategy-moon-row.js", "content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["overlay.css"],
    });
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["inject.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["strategy-moon-row.js", "content.js"],
    });
  }
}

async function send(type, extra = {}) {
  const tab = await crashTab();
  if (!tab) {
    document.getElementById("pageHint").textContent =
      "Open bc.game or bcmail2.com crash page first.";
    document.getElementById("msg").textContent =
      "Go to the crash tab, then open the extension again.";
    return null;
  }
  document.getElementById("pageHint").textContent = tab.url;

  let status = await ping(tab.id);
  if (!status) {
    document.getElementById("msg").textContent = "Connecting…";
    try {
      await injectBot(tab.id);
      await new Promise((r) => setTimeout(r, 250));
      status = await ping(tab.id);
    } catch (err) {
      document.getElementById("msg").textContent =
        "Could not attach: " + (err && err.message ? err.message : err);
      return null;
    }
  }
  if (!status) {
    document.getElementById("msg").textContent =
      "Not connected — reload extension and refresh crash tab.";
    return null;
  }
  if (type === "GET_STATUS") return status;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...extra });
  } catch (err) {
    document.getElementById("msg").textContent =
      "Failed: " + (err && err.message ? err.message : err);
    return null;
  }
}

let formReady = false;

function fillForm(cfg) {
  if (!cfg) return;
  const form = document.getElementById("cfg");
  if (form.contains(document.activeElement)) return;
  KEYS.forEach((k) => {
    if (cfg[k] != null && form.elements[k]) {
      form.elements[k].value = cfg[k];
    }
  });
}

function readForm() {
  const form = document.getElementById("cfg");
  const out = {};
  KEYS.forEach((k) => {
    const v = form.elements[k].value;
    out[k] = INT_KEYS.includes(k) ? parseInt(v, 10) : parseFloat(v);
  });
  return out;
}

function fmtAmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(4);
}

function renderLog(rows, snap) {
  document.getElementById("logWon").textContent = Number(snap.total_won || 0).toFixed(4);
  document.getElementById("logLost").textContent = Number(snap.total_lost || 0).toFixed(4);
  const pl = Number(snap.session_pnl || 0);
  const pnlEl = document.getElementById("logPnl");
  pnlEl.textContent = fmtAmt(pl);
  pnlEl.className = pl >= 0 ? "win" : "lose";

  const box = document.getElementById("logList");
  if (!rows.length) {
    box.innerHTML = `<div class="log-empty">No bets yet.</div>`;
    return;
  }
  box.innerHTML = rows
    .slice()
    .reverse()
    .map((r) => {
      const kind = r.kind || "bet";
      const label = kind === "win" ? "WIN" : kind === "lose" ? "LOSE" : "BET";
      const amount =
        kind === "bet" ? `@ ${r.cashout ?? "—"}x` : fmtAmt(r.profit);
      let round = "—";
      if (r.crash != null && r.crashId != null) round = `${r.crash}x #${r.crashId}`;
      else if (r.gameId != null) round = `#${r.gameId}`;
      return `<div class="log-row ${kind}">
        <span>${r.t || ""}</span>
        <span class="kind">${label}</span>
        <span>${r.stake ?? "—"}</span>
        <span class="${kind === "win" ? "win" : kind === "lose" ? "lose" : ""}">${amount}</span>
        <span>${round}</span>
      </div>`;
    })
    .join("");
}

function render(s, { syncForm = false } = {}) {
  if (!s) return;

  const betting = document.getElementById("betting");
  betting.textContent = s.betting_enabled ? "ON" : "off";
  betting.className = s.betting_enabled ? "win" : "lose";

  document.getElementById("rowStat").textContent =
    `${s.row_type || "—"} pos ${s.row_pos ?? 0}`;
  document.getElementById("seqStat").textContent = s.sequence_attempt
    ? `${s.sequence_attempt}/${s.sequence_max}`
    : "—";
  document.getElementById("stake").textContent = s.current_stake ?? "—";

  const pnl = document.getElementById("pnl");
  pnl.textContent = Number(s.session_pnl || 0).toFixed(4);
  pnl.className = (s.session_pnl || 0) >= 0 ? "win" : "lose";

  document.getElementById("wl").textContent = `${s.wins ?? 0} / ${s.losses ?? 0}`;
  document.getElementById("seqWl").textContent =
    `${s.sequences_won ?? 0} / ${s.sequences_lost ?? 0}`;
  document.getElementById("bal").textContent =
    s.current_balance != null ? Number(s.current_balance).toFixed(4) : "—";
  document.getElementById("msg").textContent = s.site_message || "—";

  renderLog(Array.isArray(s.bet_log) ? s.bet_log : [], s);

  if ((syncForm || !formReady) && s.config) {
    fillForm(s.config);
    formReady = true;
  }
}

function showTab(id) {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === id);
  });
  document.getElementById("panelBot").classList.toggle("hidden", id !== "bot");
  document.getElementById("panelLog").classList.toggle("hidden", id !== "log");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => showTab(btn.getAttribute("data-tab"));
});

document.getElementById("btnStart").onclick = async () => {
  const config = readForm();
  document.getElementById("msg").textContent = "Starting…";
  await send("UPDATE_CONFIG", { config });
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
  render(await send("UPDATE_CONFIG", { config: readForm() }), { syncForm: true });
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
