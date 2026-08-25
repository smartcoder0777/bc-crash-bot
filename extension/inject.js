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
    const m = s.match(/game_item\s*=>\s*(\d+)[,\s]+(\d+(?:\.\d+)?)/i);
    if (!m) return;
    emitGameItem(m[1], m[2]);
  };

  const parseConsoleArgs = (args) => {
    try {
      parseGameItemText(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
      const joined = args.join(" ");
      if (/game_item/i.test(joined) && args.length >= 2) {
        const nums = args.map((a) => Number(a)).filter((n) => Number.isFinite(n));
        if (nums.length >= 2) emitGameItem(nums[0], nums[1]);
      }
    } catch (_) {}
  };

  const wrapConsole = (obj, key) => {
    try {
      const orig = obj[key];
      if (typeof orig !== "function" || orig.__bcHooked) return;
      const wrapped = function (...args) {
        parseConsoleArgs(args);
        return orig.apply(this, args);
      };
      wrapped.__bcHooked = true;
      try {
        Object.defineProperty(obj, key, {
          value: wrapped,
          writable: true,
          configurable: true,
        });
      } catch (_) {
        obj[key] = wrapped;
      }
    } catch (_) {}
  };

  const hookAllConsoles = () => {
    wrapConsole(console, "log");
    wrapConsole(console, "info");
    wrapConsole(console, "debug");
    wrapConsole(console, "warn");
  };
  hookAllConsoles();
  setInterval(hookAllConsoles, 400);

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
          root[name] = wrapped;
        } catch (_) {}
      }
    }
  };
  hookSend();
  setInterval(hookSend, 200);

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
        const gm = text.match(/"?(?:crash|bust|point|crashPoint|multiplier)"?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
        if (gm) {
          const v = parseFloat(gm[1]);
          if (v >= 1 && v < 1e6) emit({ type: "ws", data: text.slice(0, 4000) });
        } else {
          emit({ type: "ws", data: text.slice(0, 4000) });
        }
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
