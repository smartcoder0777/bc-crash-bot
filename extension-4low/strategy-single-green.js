/** N× single-green sandwiches → next green → bet following round. */
(() => {
  if (globalThis.__bcSingleGreenStrategyLoaded) return;
  globalThis.__bcSingleGreenStrategyLoaded = true;

  const SgMode = {
    WATCHING: "watching",
    STOPPED: "stopped",
  };

  function defaultSingleGreenConfig() {
    return {
      stake: 100,
      cashout: 2,
      green: 2,
      single_greens_required: 3,
      stop_loss: 500,
      start_balance: 0,
    };
  }

  function defaultSingleGreenState() {
    return {
      mode: SgMode.WATCHING,
      armed: false,
      awaiting_bet: false,
      sg_count: 0,
      games: [],
      session_pnl: 0,
      total_won: 0,
      total_lost: 0,
      bets_placed: 0,
      wins: 0,
      losses: 0,
      last_result: "-",
      last_crash: null,
      message: "Idle — count 3× single-green, then bet round after next ≥2×",
      history: [],
    };
  }

  function round8(n) {
    return Math.round(Number(n) * 1e8) / 1e8;
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function isConsecutive(rows, i) {
    if (i <= 0 || i >= rows.length - 1) return false;
    return rows[i + 1].id === rows[i].id + 1 && rows[i].id === rows[i - 1].id + 1;
  }

  function isSingleGreen(rows, i, green) {
    if (!isConsecutive(rows, i)) return false;
    return rows[i].value >= green && rows[i - 1].value < green && rows[i + 1].value < green;
  }

  class SingleGreenEngine {
    constructor(config) {
      this.config = { ...defaultSingleGreenConfig(), ...config };
      this.state = defaultSingleGreenState();
      this._syncMessage();
    }

    _syncMessage() {
      const cfg = this.config;
      const st = this.state;
      if (st.mode === SgMode.STOPPED) return;
      const need = Number(cfg.single_greens_required) || 3;
      const gr = Number(cfg.green) || 2;
      if (st.awaiting_bet) {
        st.message = `Trigger green seen — betting next round @ ${cfg.cashout}x`;
        return;
      }
      if (st.armed) {
        st.message = `Armed (${need}× SG) — waiting for next ≥${gr}× green`;
        return;
      }
      st.message = `Single greens: ${st.sg_count}/${need} (green ≥${gr}×)`;
    }

    snapshot() {
      const st = this.state;
      const start = Number(this.config.start_balance) || 0;
      return {
        mode: st.mode,
        armed: st.armed,
        awaiting_bet: st.awaiting_bet,
        sg_count: st.sg_count,
        sg_needed: Number(this.config.single_greens_required) || 3,
        current_stake: round8(this.config.stake),
        session_pnl: round8(st.session_pnl),
        total_won: round8(st.total_won),
        total_lost: round8(st.total_lost),
        bets_placed: st.bets_placed,
        wins: st.wins,
        losses: st.losses,
        last_result: st.last_result,
        last_crash: st.last_crash,
        message: st.message,
        history: st.history.slice(),
        start_balance: round8(start),
        current_balance: round8(start + st.session_pnl),
      };
    }

    setStartBalance(amount) {
      this.config.start_balance = Number(amount) || 0;
      this._syncMessage();
    }

    updateConfig(data) {
      this.config = { ...this.config, ...data };
      this._syncMessage();
    }

    reset() {
      this.config.start_balance = 0;
      this.state = defaultSingleGreenState();
      this._syncMessage();
      this.state.message = "Reset — counting single greens again";
    }

    replayGames(games) {
      this.initFromBanner(games);
    }

    /** Set SG state from banner history (same rules as dashboard batch walk). */
    initFromBanner(games) {
      const st = defaultSingleGreenState();
      const green = Number(this.config.green) || 2;
      const need = Number(this.config.single_greens_required) || 3;
      const rows = (games || [])
        .map((g) => ({ id: Number(g.id), value: round2(g.value) }))
        .filter((g) => Number.isFinite(g.id) && g.id > 0 && g.value > 0)
        .sort((a, b) => a.id - b.id);

      st.games = rows.slice(-40);

      let c = 0;
      let armed = false;
      for (let i = 1; i < rows.length - 1; i++) {
        if (rows[i].value >= green) {
          if (armed) {
            armed = false;
            c = 0;
          } else if (isSingleGreen(rows, i, green)) {
            c += 1;
            if (c >= need) {
              armed = true;
              c = 0;
            }
          } else {
            c = 0;
          }
        }
      }

      st.sg_count = c;
      st.armed = armed;
      st.awaiting_bet = false;
      this.state = st;
      this._syncMessage();
    }

    shouldBet() {
      if (this.state.mode === SgMode.STOPPED) return false;
      if (this._hitStopLoss()) {
        this._stop("Stop-loss reached");
        return false;
      }
      return !!this.state.awaiting_bet;
    }

    nextBet() {
      if (!this.shouldBet()) return null;
      return {
        stake: round8(this.config.stake),
        cashout: this.config.cashout,
      };
    }

    onMissedBet() {
      this.state.awaiting_bet = false;
      this._syncMessage();
    }

    onRoundObserved(crashAt, id, opts) {
      const crash = round2(crashAt);
      const st = this.state;
      const cfg = this.config;
      const green = Number(cfg.green) || 2;
      const need = Number(cfg.single_greens_required) || 3;

      if (st.mode === SgMode.STOPPED) return;

      let gameId = Number(id);
      if (!Number.isFinite(gameId) || gameId <= 0) {
        gameId = st.games.length ? st.games[st.games.length - 1].id + 1 : 1;
      }

      const row = { id: gameId, value: crash };
      st.games.push(row);
      if (st.games.length > 40) st.games.shift();
      st.last_crash = crash;

      const i = st.games.length - 1;

      // Armed → any green is the trigger; bet the following round.
      if (st.armed && crash >= green) {
        st.awaiting_bet = true;
        st.armed = false;
        st.sg_count = 0;
        if (!opts || !opts.replay) this._syncMessage();
        return;
      }

      // Middle green at i-1 is fully known once round i lands (matches dashboard loop at green index).
      if (i >= 2 && isConsecutive(st.games, i - 1) && st.games[i - 1].value >= green) {
        if (isSingleGreen(st.games, i - 1, green)) {
          st.sg_count += 1;
          if (st.sg_count >= need) {
            st.armed = true;
            st.sg_count = 0;
          }
        } else {
          st.sg_count = 0;
        }
        if (!opts || !opts.replay) this._syncMessage();
        return;
      }

      if (!opts || !opts.replay) this._syncMessage();
    }

    onBetResult(won, stake, crashAt) {
      const cfg = this.config;
      const st = this.state;
      st.bets_placed += 1;
      st.last_crash = crashAt ?? null;
      st.awaiting_bet = false;
      st.armed = false;
      st.sg_count = 0;

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
        st.message = `Win +${profit.toFixed(4)} — counting single greens again`;
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
        st.message = `Lose −${stake} — counting single greens again`;
      }

      if (this._hitStopLoss()) this._stop("Stop-loss reached");
      else this._syncMessage();
    }

    _hitStopLoss() {
      return this.state.session_pnl <= -Math.abs(this.config.stop_loss);
    }

    _stop(reason) {
      this.state.mode = SgMode.STOPPED;
      this.state.awaiting_bet = false;
      this.state.armed = false;
      this.state.message = reason;
    }
  }

  globalThis.SgMode = SgMode;
  globalThis.defaultSingleGreenConfig = defaultSingleGreenConfig;
  globalThis.SingleGreenEngine = SingleGreenEngine;
})();
