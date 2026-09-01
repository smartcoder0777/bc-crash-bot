const KEEPALIVE_ALARM = "bcmoon-keepalive";
const TICK_MS = 4000;
const TICK_ARMED_MS = 500;
const TICK_PENDING_MS = 350;

const CRASH_URLS = [
  "*://*.bc.game/*",
  "*://bc.game/*",
  "*://*.bcmail2.com/*",
  "*://bcmail2.com/*",
];

const INJECT_FILES = ["strategy-moon-row.js", "content.js"];

function scheduleKeepalive(ms) {
  chrome.alarms.clear(KEEPALIVE_ALARM, () => {
    chrome.alarms.create(KEEPALIVE_ALARM, { when: Date.now() + ms });
  });
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

async function crashTabs() {
  return chrome.tabs.query({ url: CRASH_URLS });
}

async function setTabUndiscardable(tabId, on) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: !on });
  } catch (_) {}
}

async function ensureInject(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["inject.js"],
      world: "MAIN",
    });
  } catch (_) {}
}

async function ensureContent(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: INJECT_FILES,
    });
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["overlay.css"],
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function pingCrashTabs(data) {
  const tabs = await crashTabs();
  for (const tab of tabs) {
    if (data && data.betting_enabled) {
      await setTabUndiscardable(tab.id, true);
      await ensureInject(tab.id);
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "KEEPALIVE_TICK" });
    } catch (_) {
      if (data && data.betting_enabled) {
        await ensureContent(tab.id);
        await ensureInject(tab.id);
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "KEEPALIVE_TICK" });
        } catch (_) {}
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("config", (data) => {
    if (!data.config) {
      chrome.storage.local.set({
        config: {
          stake: 100,
          cashout: 1.96,
          martingale: 2,
          max_attempts: 3,
          moon_min: 10,
          cat_min: 100,
          pos2_max_first: 4,
          filter_rows: 10,
          stop_loss: 500,
        },
        betting_enabled: false,
        awaiting_bet: false,
        pending_bet: false,
      });
    }
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  const data = await chrome.storage.local.get(["betting_enabled", "awaiting_bet", "pending_bet"]);
  if (!data.betting_enabled) {
    stopKeepalive();
    const tabs = await crashTabs();
    for (const tab of tabs) await setTabUndiscardable(tab.id, false);
    return;
  }
  const ms = data.pending_bet ? TICK_PENDING_MS : data.awaiting_bet ? TICK_ARMED_MS : TICK_MS;
  scheduleKeepalive(ms);
  await pingCrashTabs(data);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "BETTING_ON") {
    chrome.storage.local.set({ betting_enabled: true }, async () => {
      scheduleKeepalive(TICK_MS);
      const tabs = await crashTabs();
      for (const tab of tabs) {
        await setTabUndiscardable(tab.id, true);
        await ensureInject(tab.id);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "BETTING_OFF") {
    chrome.storage.local.set({ betting_enabled: false, awaiting_bet: false, pending_bet: false }, async () => {
      stopKeepalive();
      const tabs = await crashTabs();
      for (const tab of tabs) await setTabUndiscardable(tab.id, false);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "AWAITING_BET") {
    chrome.storage.local.set({ awaiting_bet: !!msg.value }, () => {
      if (msg.value) scheduleKeepalive(TICK_ARMED_MS);
    });
    return;
  }
  if (msg.type === "PENDING_BET") {
    chrome.storage.local.set({ pending_bet: !!msg.value }, () => {
      if (msg.value) scheduleKeepalive(TICK_PENDING_MS);
    });
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.betting_enabled) return;
  if (changes.betting_enabled.newValue) scheduleKeepalive(TICK_MS);
  else stopKeepalive();
});
