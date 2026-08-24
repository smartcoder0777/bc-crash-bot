chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("config", (data) => {
    if (!data.config) {
      chrome.storage.local.set({
        config: {
          base_stake: 0.02,
          cashout: 1.45,
          loss_multiplier: 3.15,
          losses_before_rest: 3,
          rest_rounds: 1,
          recovery_attempts: 2,
          stop_loss: 50,
        },
      });
    }
  });
});
