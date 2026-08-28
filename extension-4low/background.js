const KEEPALIVE_ALARM = "bc4low-keepalive";
const TICK_MS = 4000;
const TICK_ARMED_MS = 2500;

function scheduleKeepalive(ms) {
  chrome.alarms.clear(KEEPALIVE_ALARM, () => {
    chrome.alarms.create(KEEPALIVE_ALARM, { when: Date.now() + ms });
  });
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

async function pingCrashTabs() {
  const tabs = await chrome.tabs.query({
    url: [
      "*://*.bc.game/*",
      "*://bc.game/*",
      "*://*.bcmail2.com/*",
      "*://bcmail2.com/*",
    ],
  });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "KEEPALIVE_TICK" });
    } catch (_) {}
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("config", (data) => {
    if (!data.config) {
      chrome.storage.local.set({
        config: {
          enabled_streak_low: true,
          enabled_single_green: false,
          streak_low: {
            stake: 100,
            cashout: 1.9,
            low_below: 1.45,
            streak_needed: 4,
            skip_on_lose: 6,
            stop_loss: 500,
          },
          single_green: {
            stake: 100,
            cashout: 2,
            green: 2,
            single_greens_required: 3,
            stop_loss: 500,
          },
        },
        betting_enabled: false,
        awaiting_bet: false,
      });
    }
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  const data = await chrome.storage.local.get(["betting_enabled", "awaiting_bet"]);
  if (!data.betting_enabled) {
    stopKeepalive();
    return;
  }
  const ms = data.awaiting_bet ? TICK_ARMED_MS : TICK_MS;
  scheduleKeepalive(ms);
  await pingCrashTabs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "BETTING_ON") {
    chrome.storage.local.set({ betting_enabled: true }, () => {
      scheduleKeepalive(TICK_MS);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "BETTING_OFF") {
    chrome.storage.local.set({ betting_enabled: false, awaiting_bet: false }, () => {
      stopKeepalive();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "AWAITING_BET") {
    chrome.storage.local.set({ awaiting_bet: !!msg.value });
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.betting_enabled) return;
  if (changes.betting_enabled.newValue) scheduleKeepalive(TICK_MS);
  else stopKeepalive();
});
