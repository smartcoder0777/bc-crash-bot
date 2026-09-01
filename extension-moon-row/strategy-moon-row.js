/** Moon Row — bet red after valid moon positions in a trend-board row. */
(() => {
  if (globalThis.__bcMoonRowStrategyLoaded) return;
  globalThis.__bcMoonRowStrategyLoaded = true;

  const MoonMode = {
    WATCHING: "watching",
    STOPPED: "stopped",
  };

  function defaultMoonRowConfig() {
    return {
      stake: 100,
      cashout: 1.96,
      martingale: 2,
      max_attempts: 3,
      moon_min: 10,
      cat_min: 100,
      red_below: 2,
      pos2_max_first: 4,
      filter_rows: 10,
      stop_loss: 500,
      start_balance: 0,
    };
  }

  function defaultMoonRowState() {
    return {
      mode: MoonMode.WATCHING,
      message: "Watching rows — moon pos 1, 2 (<4× first), or 5+",
      current_row: null,
      completed_rows: [],
      sequence: null,
      awaiting_bet: false,
      used_triggers: [],
      last_game_id: 0,
      session_pnl: 0,
      total_won: 0,
      total_lost: 0,
      bets_placed: 0,
      wins: 0,
      losses: 0,
      sequences_won: 0,
      sequences_lost: 0,
      last_result: "-",
      last_crash: null,
      last_multiplier_seen: null,
      history: [],
    };
  }

  function round8(n) {
    return Math.round(Number(n) * 1e8) / 1e8;
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function rowSide(crash, redBelow) {
    return crash + 1e-9 < redBelow ? "red" : "green";
  }

  function isMoon(crash, cfg) {
    const v = round2(crash);
    return v + 1e-9 >= cfg.moon_min && v + 1e-9 < cfg.cat_min;
  }

  function isCat(crash, cfg) {
    return round2(crash) + 1e-9 >= cfg.cat_min;
  }

  function rowHasCat(row, cfg) {
    return row.rounds.some((r) => isCat(r.value, cfg));
  }

  function rowHasTwinMoons(row, cfg) {
    const rs = row.rounds;
    for (let i = 1; i < rs.length; i++) {
      if (isMoon(rs[i - 1].value, cfg) && isMoon(rs[i].value, cfg)) return true;
    }
    return false;
  }

  function filterPass(completedRows, cfg) {
    const n = Number(cfg.filter_rows) || 10;
    const check = completedRows.slice(-n);
    for (const row of check) {
      if (rowHasCat(row, cfg) || rowHasTwinMoons(row, cfg)) return false;
    }
    return true;
  }

  function isValidMoonTrigger(row, pos, crash, cfg) {
    if (!isMoon(crash, cfg)) return false;
    if (pos === 1) return true;
    if (pos === 2) {
      const first = row.rounds[0];
      return first && first.value + 1e-9 < Number(cfg.pos2_max_first || 4);
    }
    if (pos === 3 || pos === 4) return false;
    if (pos >= 5) return true;
    return false;
  }

  class MoonRowEngine {
    constructor(config) {
      this.config = { ...defaultMoonRowConfig(), ...config };
      this.state = defaultMoonRowState();
      this._syncMessage();
    }

    _syncMessage() {
      const st = this.state;
      const cfg = this.config;
      if (st.mode === MoonMode.STOPPED) return;
      if (st.sequence && st.awaiting_bet) {
        const att = st.sequence.attempt;
        const max = Number(cfg.max_attempts) || 3;
        st.message = `RED bet ${att}/${max} after moon #${st.sequence.trigger_id} (row pos ${st.sequence.trigger_pos})`;
        return;
      }
      if (st.sequence) {
        st.message = `Sequence active — attempt ${st.sequence.attempt}/${cfg.max_attempts || 3}`;
        return;
      }
      const row = st.current_row;
      if (row && row.rounds.length) {
        const pos = row.rounds.length;
        const side = row.type;
        st.message = `Row ${side} pos ${pos} — watching for moon trigger`;
      } else {
        st.message = "Watching rows — moon pos 1, 2 (<4× first), or 5+";
      }
    }

    snapshot() {
      const st = this.state;
      const cfg = this.config;
      const start = Number(cfg.start_balance) || 0;
      const seq = st.sequence;
      let stake = round8(cfg.stake);
      if (seq) {
        const mg = Number(cfg.martingale) || 2;
        stake = round8(cfg.stake * Math.pow(mg, Math.max(0, seq.attempt - 1)));
      }
      return {
        mode: st.mode,
        message: st.message,
        row_type: st.current_row ? st.current_row.type : "—",
        row_pos: st.current_row ? st.current_row.rounds.length : 0,
        completed_rows: st.completed_rows.length,
        awaiting_bet: st.awaiting_bet,
        sequence_attempt: seq ? seq.attempt : 0,
        sequence_max: Number(cfg.max_attempts) || 3,
        current_stake: stake,
        session_pnl: round8(st.session_pnl),
        total_won: round8(st.total_won),
        total_lost: round8(st.total_lost),
        bets_placed: st.bets_placed,
        wins: st.wins,
        losses: st.losses,
        sequences_won: st.sequences_won,
        sequences_lost: st.sequences_lost,
        last_result: st.last_result,
        last_crash: st.last_crash,
        history: st.history.slice(),
        start_balance: round8(start),
        current_balance: round8(start + st.session_pnl),
      };
    }

    setStartBalance(amount) {
      this.config.start_balance = Number(amount) || 0;
    }

    updateConfig(data) {
      this.config = { ...this.config, ...data };
      this._syncMessage();
    }

    reset() {
      this.config.start_balance = 0;
      this.state = defaultMoonRowState();
      this.state.message = "Reset — watching moon rows";
    }

    _closeCurrentRow() {
      const st = this.state;
      if (st.current_row && st.current_row.rounds.length) {
        st.completed_rows.push(st.current_row);
        if (st.completed_rows.length > 80) st.completed_rows.shift();
      }
      st.current_row = null;
    }

    _addRound(id, crash) {
      const cfg = this.config;
      const st = this.state;
      const side = rowSide(crash, cfg.red_below);
      const row = { id: Number(id), value: round2(crash), pos: 0 };

      if (!st.current_row) {
        st.current_row = { type: side, rounds: [] };
      } else if (st.current_row.type !== side) {
        this._closeCurrentRow();
        st.current_row = { type: side, rounds: [] };
      }

      row.pos = st.current_row.rounds.length + 1;
      st.current_row.rounds.push(row);
      st.last_crash = row.value;
      st.last_game_id = row.id;
      return row;
    }

    _triggerUsed(id) {
      return this.state.used_triggers.indexOf(id) >= 0;
    }

    _markTriggerUsed(id) {
      if (!this._triggerUsed(id)) {
        this.state.used_triggers.push(id);
        if (this.state.used_triggers.length > 200) this.state.used_triggers.shift();
      }
    }

    _endSequence(reason, won) {
      const st = this.state;
      if (won) st.sequences_won += 1;
      else if (reason !== "moon_abort") st.sequences_lost += 1;
      st.sequence = null;
      st.awaiting_bet = false;
      if (reason) {
        st.message =
          reason === "win"
            ? "Sequence won — watching for next moon trigger"
            : reason === "moon_abort"
              ? "Moon on bet round — sequence stopped"
              : reason === "max_losses"
                ? "3 losses — sequence reset, watching rows"
                : `Sequence ended (${reason})`;
      }
      this._syncMessage();
    }

    _startSequence(triggerId, triggerPos) {
      const st = this.state;
      this._markTriggerUsed(triggerId);
      st.sequence = {
        attempt: 1,
        trigger_id: triggerId,
        trigger_pos: triggerPos,
        arm_after_id: triggerId,
      };
      st.awaiting_bet = true;
      this._syncMessage();
    }

    _checkTrigger(round, row) {
      const st = this.state;
      const cfg = this.config;
      if (st.mode === MoonMode.STOPPED) return;
      if (st.sequence || st.awaiting_bet) return;
      if (this._triggerUsed(round.id)) return;
      if (!isValidMoonTrigger(row, round.pos, round.value, cfg)) return;
      if (!filterPass(st.completed_rows, cfg)) {
        this._markTriggerUsed(round.id);
        st.message = `Moon #${round.id} pos ${round.pos} — filter blocked (10-row cat/twin)`;
        this._syncMessage();
        return;
      }
      this._startSequence(round.id, round.pos);
      st.message = `Moon #${round.id} pos ${round.pos} — bet RED next round`;
      this._syncMessage();
    }

    replayGames(games) {
      const st = defaultMoonRowState();
      this.state = st;
      const sorted = (games || [])
        .map((g) => ({ id: Number(g.id), value: round2(g.value != null ? g.value : g.v) }))
        .filter((g) => g.id > 0 && g.value > 0)
        .sort((a, b) => a.id - b.id);
      for (const g of sorted) {
        this._processRound(g.id, g.value, { replay: true });
      }
      this._syncMessage();
    }

    _processRound(id, crash, opts) {
      const st = this.state;
      if (st.mode === MoonMode.STOPPED) return;
      const gid = Number(id);
      if (!gid || gid <= st.last_game_id) return;

      const round = this._addRound(gid, crash);
      const row = st.current_row;

      if (!opts || !opts.replay) {
        this._checkTrigger(round, row);
      }
      this._syncMessage();
    }

    ingestRound(id, crash) {
      this._processRound(id, crash, { replay: true });
    }

    onRoundObserved(crash, id) {
      this._processRound(id, crash, {});
    }

    shouldBet() {
      if (this.state.mode === MoonMode.STOPPED) return false;
      if (this._hitStopLoss()) {
        this._stop("Stop-loss reached");
        return false;
      }
      return !!this.state.awaiting_bet && !!this.state.sequence;
    }

    nextBet() {
      if (!this.shouldBet()) return null;
      const cfg = this.config;
      const seq = this.state.sequence;
      const mg = Number(cfg.martingale) || 2;
      const stake = round8(cfg.stake * Math.pow(mg, Math.max(0, seq.attempt - 1)));
      return { stake, cashout: cfg.cashout };
    }

    /** Red win = crash below cashout (default 1.96×). */
    onBetResult(won, stake, crashAt, gameId) {
      const cfg = this.config;
      const st = this.state;
      const crash = round2(crashAt);
      const gid = Number(gameId);

      st.bets_placed += 1;
      st.last_crash = crash;
      st.awaiting_bet = false;

      if (isMoon(crash, cfg)) {
        const profit = round8(-stake);
        st.session_pnl += profit;
        st.total_lost += stake;
        st.losses += 1;
        st.last_result = "lose";
        st.history.push({ result: "lose", stake, profit, crash, note: "moon on bet round" });
        this._endSequence("moon_abort", false);
        if (this._hitStopLoss()) this._stop("Stop-loss reached");
        return;
      }

      if (won) {
        const profit = stake * (cfg.cashout - 1);
        st.session_pnl += profit;
        st.total_won += profit;
        st.wins += 1;
        st.last_result = "win";
        st.history.push({ result: "win", stake, profit: round8(profit), crash });
        this._endSequence("win", true);
      } else {
        st.session_pnl -= stake;
        st.total_lost += stake;
        st.losses += 1;
        st.last_result = "lose";
        st.history.push({ result: "lose", stake, profit: round8(-stake), crash });
        const seq = st.sequence;
        if (!seq) {
          this._endSequence("orphan_loss", false);
        } else if (seq.attempt >= (Number(cfg.max_attempts) || 3)) {
          this._endSequence("max_losses", false);
        } else {
          seq.attempt += 1;
          if (gid > 0) seq.arm_after_id = gid;
          st.awaiting_bet = true;
          this._syncMessage();
        }
      }

      if (this._hitStopLoss()) this._stop("Stop-loss reached");
    }

    armAfterId() {
      const seq = this.state.sequence;
      return seq ? seq.arm_after_id || seq.trigger_id : 0;
    }

    _hitStopLoss() {
      return this.state.session_pnl <= -Math.abs(this.config.stop_loss);
    }

    _stop(reason) {
      this.state.mode = MoonMode.STOPPED;
      this.state.awaiting_bet = false;
      this.state.sequence = null;
      this.state.message = reason;
    }
  }

  globalThis.MoonMode = MoonMode;
  globalThis.defaultMoonRowConfig = defaultMoonRowConfig;
  globalThis.MoonRowEngine = MoonRowEngine;
})();
