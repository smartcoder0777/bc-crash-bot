document.getElementById("extVer").textContent =
  "v" + chrome.runtime.getManifest().version;

const STREAK_KEYS = [
  "stake",
  "cashout",
  "low_below",
  "streak_needed",
  "skip_on_lose",
  "stop_loss",
];
const SG_KEYS = ["stake", "cashout", "green", "single_greens_required", "stop_loss"];

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
    files: [
      "strategy.js",
      "strategy-single-green.js",
      "config.js",
      "content.js",
    ],
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
      "Still not connected. Reload the extension, refresh the crash page, then try Start.";
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

function fillFormKeys(form, cfg, keys, intKeys) {
  if (!cfg || !form) return;
  keys.forEach((k) => {
    if (cfg[k] != null && form.elements[k]) form.elements[k].value = cfg[k];
  });
}

function readFormKeys(form, keys, intKeys) {
  const out = {};
  keys.forEach((k) => {
    const v = form.elements[k].value;
    out[k] = intKeys.includes(k) ? parseInt(v, 10) : parseFloat(v);
  });
  return out;
}

function fillForm(cfg) {
  if (!cfg) return;
  const streakForm = document.getElementById("cfgStreak");
  const sgForm = document.getElementById("cfgSg");
  if (streakForm.contains(document.activeElement) || sgForm.contains(document.activeElement)) return;
  document.getElementById("enStreak").checked = cfg.enabled_streak_low !== false;
  document.getElementById("enSg").checked = !!cfg.enabled_single_green;
  fillFormKeys(streakForm, cfg.streak_low || {}, STREAK_KEYS, ["streak_needed", "skip_on_lose"]);
  fillFormKeys(sgForm, cfg.single_green || {}, SG_KEYS, ["single_greens_required"]);
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

function renderLogPanel(rows, boxId, wonId, lostId, pnlId, snap) {
  const won = document.getElementById(wonId);
  const lost = document.getElementById(lostId);
  const pnl = document.getElementById(pnlId);
  won.textContent = Number(snap.total_won || 0).toFixed(4);
  lost.textContent = Number(snap.total_lost || 0).toFixed(4);
  const pl = Number(snap.session_pnl || 0);
  pnl.textContent = fmtAmt(pl);
  pnl.className = pl >= 0 ? "win" : "lose";

  const box = document.getElementById(boxId);
  if (!rows.length) {
    box.innerHTML = `<div class="log-empty">No bets yet.</div>`;
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
        kind === "bet" ? `@ ${r.cashout ?? "—"}x` : fmtAmt(r.profit);
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
  const sl = s.streak_low || {};
  const sg = s.single_green || {};

  const betting = document.getElementById("betting");
  betting.textContent = s.betting_enabled ? "ON" : "off";
  betting.className = s.betting_enabled ? "win" : "lose";

  document.getElementById("armed").textContent = s.pending_strategy
    ? `${s.pending_strategy} (live)`
    : s.armed_strategy
      ? `${s.armed_strategy}${s.betting_enabled ? "" : ""}`
      : "—";

  const pnl = document.getElementById("pnl");
  pnl.textContent = Number(s.session_pnl || 0).toFixed(4);
  pnl.className = (s.session_pnl || 0) >= 0 ? "win" : "lose";
  document.getElementById("bal").textContent =
    s.current_balance != null ? Number(s.current_balance).toFixed(4) : "—";

  document.getElementById("streakStat").textContent =
    `${sl.low_streak ?? 0} / ${sl.streak_needed ?? 4} lows · ${sl.mode || "idle"}`;
  document.getElementById("streakWl").textContent = `${sl.wins ?? 0} W / ${sl.losses ?? 0} L`;
  document.getElementById("streakPnl").textContent = `P/L ${Number(sl.session_pnl || 0).toFixed(2)}`;

  document.getElementById("sgStat").textContent =
    `${sg.sg_count ?? 0} / ${sg.sg_needed ?? 3} SG${sg.armed ? " · armed" : ""}`;
  document.getElementById("sgWl").textContent = `${sg.wins ?? 0} W / ${sg.losses ?? 0} L`;
  document.getElementById("sgPnl").textContent = `P/L ${Number(sg.session_pnl || 0).toFixed(2)}`;

  document.getElementById("boxStreak").classList.toggle("off", s.enabled_streak_low === false);
  document.getElementById("boxSg").classList.toggle("off", !s.enabled_single_green);

  document.getElementById("msg").textContent = s.site_message || "—";

  renderLogPanel(
    Array.isArray(s.bet_log_streak_low) ? s.bet_log_streak_low : [],
    "logListStreak",
    "logWonStreak",
    "logLostStreak",
    "logPnlStreak",
    sl
  );
  renderLogPanel(
    Array.isArray(s.bet_log_single_green) ? s.bet_log_single_green : [],
    "logListSg",
    "logWonSg",
    "logLostSg",
    "logPnlSg",
    sg
  );

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
  document.getElementById("panelLogStreak").classList.toggle("hidden", id !== "log-streak");
  document.getElementById("panelLogSg").classList.toggle("hidden", id !== "log-sg");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => showTab(btn.getAttribute("data-tab"));
});

function buildConfigFromForms() {
  const streakForm = document.getElementById("cfgStreak");
  const sgForm = document.getElementById("cfgSg");
  return {
    enabled_streak_low: document.getElementById("enStreak").checked,
    enabled_single_green: document.getElementById("enSg").checked,
    streak_low: readFormKeys(streakForm, STREAK_KEYS, ["streak_needed", "skip_on_lose"]),
    single_green: readFormKeys(sgForm, SG_KEYS, ["single_greens_required"]),
  };
}

document.getElementById("btnStart").onclick = async () => {
  const cfg = buildConfigFromForms();
  if (!cfg.enabled_streak_low && !cfg.enabled_single_green) {
    document.getElementById("msg").textContent = "Enable at least one strategy.";
    return;
  }
  document.getElementById("msg").textContent = "Starting…";
  await send("UPDATE_CONFIG", { config: cfg });
  render(await send("START_BET"));
};

document.getElementById("btnStop").onclick = async () => {
  render(await send("STOP_BET"));
};

document.getElementById("btnReset").onclick = async () => {
  render(await send("RESET"));
};

document.getElementById("btnSave").onclick = async () => {
  const config = buildConfigFromForms();
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
