/** Page-world: crash WebSocket hooks + internal bet API. */
(function () {
  if (window.__bcMoonRowInject) return;
  window.__bcMoonRowInject = true;

  const SRC = "bc-moon-row";
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
    }
  };

  const looksLikeCrashUrl = (url) => /crash|socket\.io|engine\.io|ws/i.test(String(url || ""));

  const hookSocket = (ws, url) => {
    if (!ws || ws.__bcMoonHooked) return;
    ws.__bcMoonHooked = true;
    if (looksLikeCrashUrl(url)) crashSocket = ws;
    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      try {
        const text = typeof data === "string" ? data : "";
        if (text && text.length < 4000 && /bet|wager|amount|payout|cashout|odds/i.test(text)) {
          lastBetSend = text;
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
    for (const k of ["crash", "__crash", "CrashGame", "crashGame"]) {
      try {
        const g = window[k];
        if (g && typeof g.handleBetCrash === "function") return g;
      } catch (_) {}
    }
    return null;
  };

  const setGameFields = (g, stake, cashout) => {
    [["betAmount", stake], ["amount", stake], ["payout", cashout], ["cashout", cashout], ["odds", cashout]].forEach(
      ([key, val]) => {
        try {
          if (key in g) g[key] = val;
        } catch (_) {}
      }
    );
  };

  const placeBetInternal = async (stake, cashout) => {
    const g = findCrashGame();
    if (g) {
      try {
        setGameFields(g, stake, cashout);
        const ret = g.handleBetCrash();
        if (ret && typeof ret.then === "function") await ret;
        return { ok: true, via: "handleBetCrash" };
      } catch (err) {
        return { ok: false, why: String(err) };
      }
    }
    return { ok: false, why: "no-api" };
  };

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

  emit({ type: "inject_ready" });
})();
