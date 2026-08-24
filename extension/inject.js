/** Page-world hooks: crash WebSocket + game_item logs (instant busts). */
(function () {
  if (window.__bcBotWsHook) return;
  window.__bcBotWsHook = true;

  const emit = (payload) => {
    try {
      window.postMessage({ source: "bc-crash-bot", ...payload }, "*");
    } catch (_) {}
  };

  const emitGameItem = (id, crash) => {
    const gid = Number(id);
    const v = parseFloat(crash);
    if (!gid || !Number.isFinite(v) || v < 1) return;
    emit({ type: "game_item", id: gid, crash: v });
  };

  const parseGameItemText = (text) => {
    const s = String(text || "");
    const m = s.match(/game_item\s*=>\s*(\d+)[,\s]+([\d.]+)/i);
    if (!m) return;
    emitGameItem(m[1], m[2]);
  };

  const wrapConsole = (obj, key) => {
    const orig = obj[key];
    if (typeof orig !== "function" || orig.__bcHooked) return;
    const wrapped = function (...args) {
      try {
        parseGameItemText(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
      } catch (_) {}
      return orig.apply(this, args);
    };
    wrapped.__bcHooked = true;
    try {
      obj[key] = wrapped;
    } catch (_) {}
  };
  wrapConsole(console, "log");
  wrapConsole(console, "info");
  wrapConsole(console, "debug");

  const hookSend = () => {
    const names = ["sendGameValueUpdates", "sendGameValueUpdate"];
    for (const name of names) {
      const orig = window[name];
      if (typeof orig !== "function" || orig.__bcHooked) continue;
      const wrapped = function (...args) {
        try {
          parseGameItemText(name + " game_item => " + args.join(" "));
          if (args.length >= 2) emitGameItem(args[0], args[1]);
          if (args[0] && typeof args[0] === "object") {
            emitGameItem(args[0].id || args[0].gameId, args[0].crash || args[0].point);
          }
        } catch (_) {}
        return orig.apply(this, args);
      };
      wrapped.__bcHooked = true;
      try {
        window[name] = wrapped;
      } catch (_) {}
    }
  };
  hookSend();
  setInterval(hookSend, 1000);

  const Orig = window.WebSocket;
  if (typeof Orig === "function") {
    const Wrapped = function (url, protocols) {
      const ws = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
      ws.addEventListener("message", (ev) => {
        let text = "";
        try {
          text = typeof ev.data === "string" ? ev.data : "";
        } catch (_) {
          return;
        }
        if (!text || text.length > 8000) return;
        parseGameItemText(text);
        emit({ type: "ws", data: text.slice(0, 4000) });
      });
      return ws;
    };
    Wrapped.prototype = Orig.prototype;
    Wrapped.CONNECTING = Orig.CONNECTING;
    Wrapped.OPEN = Orig.OPEN;
    Wrapped.CLOSING = Orig.CLOSING;
    Wrapped.CLOSED = Orig.CLOSED;
    window.WebSocket = Wrapped;
  }
})();
