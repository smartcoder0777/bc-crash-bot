chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("config", (data) => {
    if (!data.config) {
      chrome.storage.local.set({
        config: {
          stake: 100,
          cashout: 1.9,
          low_below: 1.45,
          streak_needed: 4,
          skip_on_lose: 6,
          stop_loss: 500,
        },
      });
    }
  });
});
