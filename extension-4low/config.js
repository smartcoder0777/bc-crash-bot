/** Shared config shape + migration from legacy flat config. */
(() => {
  if (globalThis.__bcBotConfigLoaded) return;
  globalThis.__bcBotConfigLoaded = true;

  function defaultBotConfig() {
    return {
      enabled_streak_low: true,
      enabled_single_green: false,
      streak_low: defaultConfig(),
      single_green: defaultSingleGreenConfig(),
    };
  }

  function normalizeBotConfig(raw) {
    if (!raw || typeof raw !== "object") return defaultBotConfig();
    if (raw.streak_low && raw.single_green) {
      return {
        enabled_streak_low: raw.enabled_streak_low !== false,
        enabled_single_green: !!raw.enabled_single_green,
        streak_low: { ...defaultConfig(), ...raw.streak_low },
        single_green: { ...defaultSingleGreenConfig(), ...raw.single_green },
      };
    }
    return {
      enabled_streak_low: true,
      enabled_single_green: false,
      streak_low: {
        ...defaultConfig(),
        stake: raw.stake ?? defaultConfig().stake,
        cashout: raw.cashout ?? defaultConfig().cashout,
        low_below: raw.low_below ?? defaultConfig().low_below,
        streak_needed: raw.streak_needed ?? defaultConfig().streak_needed,
        skip_on_lose: raw.skip_on_lose ?? defaultConfig().skip_on_lose,
        stop_loss: raw.stop_loss ?? defaultConfig().stop_loss,
        start_balance: raw.start_balance ?? 0,
      },
      single_green: defaultSingleGreenConfig(),
    };
  }

  globalThis.defaultBotConfig = defaultBotConfig;
  globalThis.normalizeBotConfig = normalizeBotConfig;
})();
