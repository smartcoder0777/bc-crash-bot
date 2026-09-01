/** Page-world: crash WebSocket hooks + internal bet API (works when tab UI is throttled). */
(function () {
  if (window.__bc4lowInject) return;
  window.__bc4lowInject = true;

  const SRC = "bc-crash-4low";
  const emit = (payload) => {
    try {
      window.postMessage({ source: SRC, ...payload }, "*");
    } catch (_) {}
  };

  let lastBetSend = null;
  let crashSocket = null;
  let phase = "unknown";
  let lastPrepareAt = 0;

  const parseGameItemText = (text) => {
    const s = String(text || "");
    const m = s.match(/game_item\s*=>\s*(\d+)[,\s]+(\d+(?:\.\d+)?)/i);
    if (!m) return;
    const id = Number(m[1]);
    const crash = parseFloat(m[2]);
    if (!id || !Number.isFinite(crash) || crash < 1) return;
    emit({ type: "game_item", id, crash });
  };

  const parseSocketIoPayload = (text) => {
    if (!text || typeof text !== "string") return null;
    const t = text.trim();
    if (t === "2" || t === "3") return null;
    let body = t;
    if (body[0] === "4" && body.length > 1) body = body.slice(1);
    if (body[0] !== "2") return null;
    try {
      const arr = JSON.parse(body.slice(1));
      return Array.isArray(arr) ? arr : null;
    } catch (_) {
      return null;
    }
  };

  const onSocketMessage = (text) => {
    parseGameItemText(text);
    const pkt = parseSocketIoPayload(text);
    if (!pkt || !pkt.length) return;
    const ev = pkt[0];
    const data = pkt[1];
    if (ev === "pr" || ev === "prepare" || ev === "game_prepare") {
      phase = "betting";
      lastPrepareAt = Date.now();
      emit({ type: "phase", phase: "betting" });
    } else if (ev === "bg" || ev === "begin" || ev === "game_begin") {
      phase = "flying";
      emit({ type: "phase", phase: "flying" });
    } else if (ev === "ed" || ev === "end" || ev === "game_end") {
      phase = "crashed";
      emit({ type: "phase", phase: "crashed" });
      if (data && typeof data === "object") {
        const id = Number(data.gameId || data.id || data.roundId);
        const crash = parseFloat(data.crash || data.point || data.bust || data.rate);
        if (id && Number.isFinite(crash)) emit({ type: "game_item", id, crash });
      }
    } else if (ev === "b" || ev === "bet") {
      emit({ type: "ws_bet_ack" });
    } else if (ev === "st" || ev === "settle") {
      emit({ type: "ws_settle" });
    }
  };

  const looksLikeCrashUrl = (url) => {
    const u = String(url || "").toLowerCase();
    return /crash|socket\.io|engine\.io|ws/.test(u);
  };

  const hookSocket = (ws, url) => {
    if (!ws || ws.__bc4lowHooked) return;
    ws.__bc4lowHooked = true;
    if (looksLikeCrashUrl(url)) crashSocket = ws;
    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      try {
        const text = typeof data === "string" ? data : "";
        if (text && text.length < 4000) {
          const low = text.toLowerCase();
          if (
            /bet|wager|amount|payout|cashout|odds|auto|escape/.test(low) &&
            !/heartbeat|ping|pong/.test(low)
          ) {
            lastBetSend = text;
          }
        }
      } catch (_) {}
      return origSend(data);
    };
    ws.addEventListener("message", (ev) => {
      try {
        onSocketMessage(typeof ev.data === "string" ? ev.data : "");
      } catch (_) {}
    });
  };

  const OrigWs = window.WebSocket;
  if (typeof OrigWs === "function") {
    const Wrapped = function (url, protocols) {
      const ws = protocols !== undefined ? new OrigWs(url, protocols) : new OrigWs(url);
      hookSocket(ws, url);
      return ws;
    };
    Wrapped.prototype = OrigWs.prototype;
    Wrapped.CONNECTING = OrigWs.CONNECTING;
    Wrapped.OPEN = OrigWs.OPEN;
    Wrapped.CLOSING = OrigWs.CLOSING;
    Wrapped.CLOSED = OrigWs.CLOSED;
    window.WebSocket = Wrapped;
  }

  const findCrashGame = () => {
    const names = ["crash", "__crash", "CrashGame", "crashGame"];
    for (const n of names) {
      try {
        const g = window[n];
        if (g && typeof g.handleBetCrash === "function") return g;
      } catch (_) {}
    }
    for (const k of Object.keys(window)) {
      if (k.length > 40) continue;
      try {
        const g = window[k];
        if (!g || typeof g !== "object") continue;
        if (typeof g.handleBetCrash === "function" && (g.socket || g.canBet != null)) return g;
      } catch (_) {}
    }
    return null;
  };

  const setGameFields = (g, stake, cashout) => {
    const pairs = [
      ["betAmount", stake],
      ["amount", stake],
      ["wager", stake],
      ["stake", stake],
      ["payout", cashout],
      ["cashout", cashout],
      ["autoCashout", cashout],
      ["odds", cashout],
      ["rate", cashout],
    ];
    for (const [key, val] of pairs) {
      try {
        if (key in g) g[key] = val;
      } catch (_) {}
    }
    try {
      if (g.betInfo && typeof g.betInfo === "object") {
        g.betInfo.amount = stake;
        g.betInfo.wager = stake;
        g.betInfo.odds = cashout;
        g.betInfo.payout = cashout;
      }
    } catch (_) {}
  };

  const mutateBetSend = (template, stake, cashout) => {
    let out = template;
    const stakeStr = String(stake);
    const cashStr = String(cashout);
    const reps = [
      [/("amount"\s*:\s*)([\d.]+)/gi, `$1${stakeStr}`],
      [/("wager"\s*:\s*)([\d.]+)/gi, `$1${stakeStr}`],
      [/("betAmount"\s*:\s*)([\d.]+)/gi, `$1${stakeStr}`],
      [/("payout"\s*:\s*)([\d.]+)/gi, `$1${cashStr}`],
      [/("cashout"\s*:\s*)([\d.]+)/gi, `$1${cashStr}`],
      [/("odds"\s*:\s*)([\d.]+)/gi, `$1${cashStr}`],
      [/("rate"\s*:\s*)([\d.]+)/gi, `$1${cashStr}`],
      [/("autoCashout"\s*:\s*)([\d.]+)/gi, `$1${cashStr}`],
    ];
    for (const [re, sub] of reps) out = out.replace(re, sub);
    return out;
  };

  const placeBetInternal = async (stake, cashout) => {
    const g = findCrashGame();
    if (g) {
      try {
        setGameFields(g, stake, cashout);
        if (g.canBet === false && Date.now() - lastPrepareAt > 15000) {
          /* still try — canBet may be stale when tab sleeps */
        }
        const ret = g.handleBetCrash();
        if (ret && typeof ret.then === "function") {
          await ret;
        }
        return { ok: true, via: "handleBetCrash" };
      } catch (err) {
        return { ok: false, why: "handleBetCrash:" + (err && err.message ? err.message : err) };
      }
    }
    if (lastBetSend && crashSocket && crashSocket.readyState === OrigWs.OPEN) {
      try {
        const msg = mutateBetSend(lastBetSend, stake, cashout);
        if (msg !== lastBetSend) {
          crashSocket.send(msg);
          return { ok: true, via: "ws-replay" };
        }
      } catch (err) {
        return { ok: false, why: "ws-replay:" + (err && err.message ? err.message : err) };
      }
    }
    return { ok: false, why: "no-api" };
  };

  const pendingPlace = {};

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || d.source !== SRC || d.type !== "PLACE_BET") return;
    const id = d.id;
    let result;
    try {
      result = await placeBetInternal(Number(d.stake), Number(d.cashout));
    } catch (err) {
      result = { ok: false, why: String(err) };
    }
    emit({ type: "PLACE_RESULT", id, result });
  });

  emit({ type: "inject_ready", phase, hasApi: !!findCrashGame(), hasWs: !!crashSocket, hasTemplate: !!lastBetSend });

  const hookConsole = () => {
    const wrap = (obj, key) => {
      try {
        const orig = obj[key];
        if (typeof orig !== "function" || orig.__bc4lowHooked) return;
        const fn = function (...args) {
          try {
            parseGameItemText(args.map((a) => String(a)).join(" "));
          } catch (_) {}
          return orig.apply(this, args);
        };
        fn.__bc4lowHooked = true;
        obj[key] = fn;
      } catch (_) {}
    };
    wrap(console, "log");
    wrap(console, "info");
    wrap(console, "debug");
  };
  hookConsole();
  setInterval(hookConsole, 500);

  const hookSend = () => {
    const names = ["sendGameValueUpdates", "sendGameValueUpdate"];
    const roots = [window];
    try {
      if (window.crash) roots.push(window.crash);
    } catch (_) {}
    for (const root of roots) {
      if (!root) continue;
      for (const name of names) {
        try {
          const orig = root[name];
          if (typeof orig !== "function" || orig.__bc4lowHooked) continue;
          const wrapped = function (...args) {
            try {
              if (args.length >= 2) emit({ type: "game_item", id: Number(args[0]), crash: Number(args[1]) });
              if (args[0] && typeof args[0] === "object") {
                emit({
                  type: "game_item",
                  id: Number(args[0].id || args[0].gameId),
                  crash: Number(args[0].crash || args[0].point),
                });
              }
            } catch (_) {}
            return orig.apply(this, args);
          };
          wrapped.__bc4lowHooked = true;
          root[name] = wrapped;
        } catch (_) {}
      }
    }
  };
  hookSend();
  setInterval(hookSend, 300);

  setInterval(() => {
    emit({ type: "heartbeat", phase, hasApi: !!findCrashGame(), hasTemplate: !!lastBetSend });
  }, 2000);
})();
