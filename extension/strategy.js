/** Same rules as strategy.py — runs in the crash tab. */
(() => {
  if (globalThis.__bcStrategyLoaded) return;
  globalThis.__bcStrategyLoaded = true;

  const Mode = {
    NORMAL: "normal",
    RESTING: "resting",
    RECOVERY: "recovery",
    STOPPED: "stopped",
  };

  function defaultConfig() {
    return {
      base_stake: 0.02,
      cashout: 1.45,
      loss_multiplier: 3.15,
      losses_before_rest: 3,
      rest_rounds: 1,
      recovery_attempts: 2,
      stop_loss: 50,
      start_balance: 0,
    };
  }

  function defaultState(cfg) {
    return {
      mode: Mode.NORMAL,
      current_stake: cfg.base_stake,
      consecutive_losses: 0,
      rest_remaining: 0,
      recovery_left: 0,
      recovery_stake: 0,
      last_lost_amount: 0,
      session_pnl: 0,
      total_won: 0,
      total_lost: 0,
      bets_placed: 0,
      wins: 0,
      losses: 0,
      last_result: "-",
      last_crash: null,
      last_multiplier_seen: null,
      message: "Idle",
      history: [],
    };
  }

  function round8(n) {
    return Math.round(Number(n) * 1e8) / 1e8;
  }

  class StrategyEngine {
    constructor(config) {
      this.config = { ...defaultConfig(), ...config };
      this.state = defaultState(this.config);
    }

    snapshot() {
      const st = this.state;
      const start = Number(this.config.start_balance) || 0;
      return {
        mode: st.mode,
        current_stake: round8(st.current_stake),
        consecutive_losses: st.consecutive_losses,
        rest_remaining: st.rest_remaining,
        recovery_left: st.recovery_left,
        recovery_stake: round8(st.recovery_stake),
        last_lost_amount: round8(st.last_lost_amount),
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
      if (amount > 0) this.state.message = `Start balance from site: ${amount}`;
    }

    updateConfig(data) {
      this.config = { ...this.config, ...data };
      if (this.state.mode === Mode.NORMAL && this.state.consecutive_losses === 0) {
        this.state.current_stake = this.config.base_stake;
      }
    }

    reset() {
      this.config.start_balance = 0;
      this.state = defaultState(this.config);
      this.state.message = "Reset — all session values cleared";
    }

    shouldBet() {
      if (this.state.mode === Mode.STOPPED) return false;
      if (this.state.mode === Mode.RESTING) return false;
      if (this._hitStopLoss()) {
        this._stop("Stop-loss reached");
        return false;
      }
      return true;
    }

    nextBet() {
      if (!this.shouldBet()) return null;
      const stake =
        this.state.mode === Mode.RECOVERY
          ? this.state.recovery_stake
          : this.state.current_stake;
      return { stake: round8(stake), cashout: this.config.cashout };
    }

    onRoundSkipped() {
      if (this.state.mode !== Mode.RESTING) return;
      this.state.rest_remaining = Math.max(0, this.state.rest_remaining - 1);
      this.state.message = `Resting… ${this.state.rest_remaining} rounds left`;
      if (this.state.rest_remaining === 0) {
        const attempts = Number(this.config.recovery_attempts) || 0;
        if (attempts <= 0) {
          this._stop("Rest done — recovery attempts is 0, bot stopped");
          return;
        }
        this.state.mode = Mode.RECOVERY;
        this.state.recovery_stake = round8(
          this.state.last_lost_amount * this.config.loss_multiplier
        );
        this.state.recovery_left = attempts;
        this.state.current_stake = this.state.recovery_stake;
        this.state.message = `Recovery ready: bet ${this.state.recovery_stake} ×${attempts} @ ${this.config.cashout}x`;
      }
    }

    resetToBase(reason) {
      this.state.mode = Mode.NORMAL;
      this.state.consecutive_losses = 0;
      this.state.rest_remaining = 0;
      this.state.recovery_left = 0;
      this.state.recovery_stake = 0;
      this.state.current_stake = this.config.base_stake;
      this.state.message = reason || `Back to base ${this.config.base_stake}`;
    }

    onBetResult(won, stake, crashAt) {
      const cfg = this.config;
      const st = this.state;
      st.bets_placed += 1;
      st.last_crash = crashAt ?? null;

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
        st.consecutive_losses = 0;
        st.mode = Mode.NORMAL;
        st.current_stake = cfg.base_stake;
        st.recovery_left = 0;
        st.recovery_stake = 0;
        st.message = `Win +${profit.toFixed(4)} -> reset to base ${cfg.base_stake}`;
      } else {
        st.session_pnl -= stake;
        st.total_lost += stake;
        st.losses += 1;
        st.last_result = "lose";
        st.last_lost_amount = stake;
        st.history.push({
          result: "lose",
          stake,
          profit: round8(-stake),
          crash: crashAt ?? null,
        });

        if (st.mode === Mode.RECOVERY) {
          st.recovery_left -= 1;
          if (st.recovery_left <= 0) {
            this._stop("Recovery failed — bot stopped");
            return;
          }
          st.recovery_stake = round8(stake);
          st.current_stake = st.recovery_stake;
          st.message = `Recovery loss — ${st.recovery_left} attempt(s) left at ${st.recovery_stake} (same stake)`;
          return;
        }

        st.consecutive_losses += 1;
        if (st.consecutive_losses >= cfg.losses_before_rest) {
          st.mode = Mode.RESTING;
          st.rest_remaining = cfg.rest_rounds;
          st.message = `${cfg.losses_before_rest} losses — resting ${cfg.rest_rounds} rounds`;
        } else {
          st.current_stake = round8(stake * cfg.loss_multiplier);
          st.message = `Loss -> next stake ${st.current_stake} (${st.consecutive_losses}/${cfg.losses_before_rest})`;
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
