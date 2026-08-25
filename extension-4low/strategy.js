/** Watch for consecutive lows, then one flat bet at cashout. */
(() => {
  if (globalThis.__bc4LowStrategyLoaded) return;
  globalThis.__bc4LowStrategyLoaded = true;

  const Mode = {
    WATCHING: "watching",
    SKIPPING: "skipping",
    STOPPED: "stopped",
  };

  function defaultConfig() {
    return {
      stake: 100,
      cashout: 1.9,
      low_below: 1.45,
      streak_needed: 4,
      skip_on_lose: 6,
      stop_loss: 500,
      start_balance: 0,
    };
  }

  function defaultState() {
    return {
      mode: Mode.WATCHING,
      low_streak: 0,
      skip_remaining: 0,
      recent_crashes: [],
      session_pnl: 0,
      total_won: 0,
      total_lost: 0,
      bets_placed: 0,
      wins: 0,
      losses: 0,
      last_result: "-",
      last_crash: null,
      last_multiplier_seen: null,
      message: "Idle — watching for 4 lows under 1.45",
      history: [],
    };
  }

  function round8(n) {
    return Math.round(Number(n) * 1e8) / 1e8;
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  class StrategyEngine {
    constructor(config) {
      this.config = { ...defaultConfig(), ...config };
      this.state = defaultState();
      this._syncMessage();
    }

    _syncMessage() {
      const cfg = this.config;
      const st = this.state;
      if (st.mode === Mode.STOPPED) return;
      if (st.mode === Mode.SKIPPING) {
        st.message = `Skip ${st.skip_remaining} round(s), then count lows again`;
        return;
      }
      const need = Number(cfg.streak_needed) || 4;
      if (st.low_streak >= need) {
        st.message = `${st.low_streak}/${need} lows < ${cfg.low_below} — bet ${cfg.stake} @ ${cfg.cashout}x next round`;
      } else {
        st.message = `Watching lows < ${cfg.low_below}: ${st.low_streak}/${need}`;
      }
    }

    snapshot() {
      const st = this.state;
      const start = Number(this.config.start_balance) || 0;
      return {
        mode: st.mode,
        current_stake: round8(this.config.stake),
        recovery_stake: 0,
        low_streak: st.low_streak,
        streak_needed: Number(this.config.streak_needed) || 4,
        skip_remaining: st.skip_remaining,
        recent_crashes: st.recent_crashes.slice(),
        session_pnl: round8(st.session_pnl),
        total_won: round8(st.total_won),
        total_lost: round8(st.total_lost),
        bets_placed: st.bets_placed,
        wins: st.wins,
        losses: st.losses,
        last_result: st.last_result,
        last_crash: st.last_crash,
        last_multiplier_seen: st.last_multiplier_seen,
        message: st.message,
        history: st.history.slice(),
        start_balance: round8(start),
        current_balance: round8(start + st.session_pnl),
      };
    }

    setStartBalance(amount) {
      this.config.start_balance = Number(amount) || 0;
      if (amount > 0 && this.state.mode !== Mode.STOPPED) {
        this.state.message = `Start balance from site: ${amount}`;
        this._syncMessage();
      }
    }

    setWatchingStreak(n, crashes) {
      this.state.mode = Mode.WATCHING;
      this.state.skip_remaining = 0;
      this.state.low_streak = Math.max(0, Number(n) || 0);
      if (Array.isArray(crashes)) this.state.recent_crashes = crashes.slice(-8);
      this._syncMessage();
    }

    updateConfig(data) {
      this.config = { ...this.config, ...data };
      this._syncMessage();
    }

    reset() {
      this.config.start_balance = 0;
      this.state = defaultState();
      this._syncMessage();
      this.state.message = "Reset — watching for 4 lows";
    }

    shouldBet() {
      if (this.state.mode === Mode.STOPPED) return false;
      if (this.state.mode === Mode.SKIPPING) return false;
      if (this._hitStopLoss()) {
        this._stop("Stop-loss reached");
        return false;
      }
      return this.state.low_streak >= (Number(this.config.streak_needed) || 4);
    }

    nextBet() {
      if (!this.shouldBet()) return null;
      return {
        stake: round8(this.config.stake),
        cashout: this.config.cashout,
      };
    }

    onRoundObserved(crashAt) {
      const crash = round2(crashAt);
      const st = this.state;
      const cfg = this.config;
      st.last_crash = crash;
      st.recent_crashes.push(crash);
      if (st.recent_crashes.length > 8) st.recent_crashes.shift();

      if (st.mode === Mode.STOPPED) return;

      if (st.mode === Mode.SKIPPING) {
        st.skip_remaining = Math.max(0, st.skip_remaining - 1);
        this._syncMessage();
        if (st.skip_remaining <= 0) {
          st.mode = Mode.WATCHING;
          st.low_streak = 0;
          this._syncMessage();
          st.message = "Skip done — counting lows again";
        }
        return;
      }

      const low = Number(cfg.low_below) || 1.45;
      if (crash + 1e-9 < low) {
        st.low_streak += 1;
      } else {
        st.low_streak = 0;
      }
      this._syncMessage();
    }

    onBetResult(won, stake, crashAt) {
      const cfg = this.config;
      const st = this.state;
      st.bets_placed += 1;
      st.last_crash = crashAt ?? null;
      st.low_streak = 0;

      if (won) {
        const profit = stake * (cfg.cashout - 1);
        st.session_pnl += profit;
        st.total_won += profit;
        st.wins += 1;
        st.last_result = "win";
        st.history.push({
          result: "win",
          stake,
          profit: round8(profit),
          crash: crashAt ?? null,
        });
        st.mode = Mode.WATCHING;
        st.skip_remaining = 0;
        st.message = `Win +${profit.toFixed(4)} — watching for next ${cfg.streak_needed} lows`;
      } else {
        st.session_pnl -= stake;
        st.total_lost += stake;
        st.losses += 1;
        st.last_result = "lose";
        st.history.push({
          result: "lose",
          stake,
          profit: round8(-stake),
          crash: crashAt ?? null,
        });
        st.mode = Mode.SKIPPING;
        st.skip_remaining = Number(cfg.skip_on_lose) || 0;
        if (st.skip_remaining <= 0) {
          st.mode = Mode.WATCHING;
          st.message = `Lose −${stake} — counting lows again`;
        } else {
          st.message = `Lose −${stake} — skip ${st.skip_remaining} rounds`;
        }
      }

      if (this._hitStopLoss()) this._stop("Stop-loss reached");
    }

    _hitStopLoss() {
      return this.state.session_pnl <= -Math.abs(this.config.stop_loss);
    }

    _stop(reason) {
      this.state.mode = Mode.STOPPED;
      this.state.message = reason;
    }
  }

  globalThis.Mode = Mode;
  globalThis.defaultConfig = defaultConfig;
  globalThis.StrategyEngine = StrategyEngine;
})();
