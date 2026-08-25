(() => {
  function boot() {
    if (window.__bcCrashBotLoaded) return;

    const engine = new StrategyEngine(defaultConfig());
  const bot = {
    betting: false,
    pending: null,
    lastPhase: "unknown",
    lastCd: null,
    roundSeq: 0,
    siteMessage: "Extension loaded. Open the popup and click Start bet.",
    logs: [],
    betLog: [],
    lastPlaceFail: 0,
    didPlaceInWindow: false,
    lastGameItem: null,
    lastSkipLog: 0,
    lastRestGameId: 0,
    placeAfter: 0,
    dead: false,
    placing: false,
    tickBusy: false,
  };

  let extVersion = "1.1.21";
  try {
    extVersion = chrome.runtime.getManifest().version;
  } catch (_) {}

  let tickTimer = null;

  function extAlive() {
    try {
      return !bot.dead && !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function die() {
    if (bot.dead) return;
    bot.dead = true;
    bot.betting = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    window.__bcCrashBotLoaded = false;
  }

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    bot.logs.push(line);
    if (bot.logs.length > 80) bot.logs.shift();
    bot.siteMessage = msg;
    console.log("[BC Bot]", msg);
    renderOverlay();
  }

  function pushBetLog(entry) {
    bot.betLog.push({
      t: new Date().toLocaleTimeString(),
      ...entry,
    });
    if (bot.betLog.length > 150) bot.betLog.shift();
  }

  function inHeader(el) {
    return !!(el && el.closest && el.closest("header, nav"));
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 16 && r.height > 10 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function isSideBetLabel(text) {
    return /^side\s*bet(\s*\(.*\))?$/i.test(String(text || "").replace(/\s+/g, " ").trim());
  }

  function findSideBetButton() {
    return allBetControls().find((b) => visible(b) && isSideBetLabel(normText(b))) || null;
  }

  function sideBetLeft() {
    const side = findSideBetButton();
    if (side) return side.getBoundingClientRect().left - 12;
    const main = findMainBetButton();
    if (main) return main.getBoundingClientRect().right + 80;
    return window.innerWidth * 0.5;
  }

  function inSideBet(el) {
    return el.getBoundingClientRect().left >= sideBetLeft();
  }

  function isFillableInput(el) {
    if (!el || el.disabled || inHeader(el) || !visible(el)) return false;
    if (inSideBet(el)) return false;
    const mode = (el.getAttribute("inputmode") || "").toLowerCase();
    const typ = (el.type || "text").toLowerCase();
    if (!(mode === "decimal" || typ === "text" || typ === "number" || typ === "tel")) return false;
    return true;
  }

  function normText(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function allBetControls() {
    const out = [];
    document.querySelectorAll("button, [role='button']").forEach((el) => out.push(el));
    return out;
  }

  function isMainBetLabel(text) {
    const s = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!s || s.length > 40) return false;
    if (s.includes("side bet")) return false;
    if (/\b(cancel|placed|all\s*in|max|min|2x|1\/2|½)\b/.test(s)) return false;
    if (/\bcash\s*out\b/.test(s) && !/\bbet\b/.test(s)) return false;
    return /^(main\s+)?bet(\s*\(.*\))?$/.test(s);
  }

  function findMainBetButton() {
    const ranked = allBetControls()
      .filter((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true" && visible(b))
      .filter((b) => {
        const tag = (b.tagName || "").toLowerCase();
        return tag === "button" || b.getAttribute("role") === "button";
      })
      .filter((b) => isMainBetLabel(normText(b)))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return ranked[0] || null;
  }

  function dismissCookies() {
    const btn = allBetControls().find((b) => /^accept$/i.test(normText(b)));
    if (btn && visible(btn)) btn.click();
  }

  function round8(n) {
    return Math.round(Number(n) * 1e8) / 1e8;
  }

  function roundTo(n, d) {
    const f = Math.pow(10, Math.max(0, d));
    return Math.round((Number(n) + Number.EPSILON) * f) / f;
  }

  function stakeText(n) {
    const x = round8(n);
    if (!Number.isFinite(x)) return "0";
    return x.toFixed(8).replace(/\.?0+$/, "");
  }

  function fieldDecimals(el, got) {
    const raw = String((el && el.value) || "");
    const m = raw.match(/\.(\d+)/);
    if (m) return m[1].length;
    const step = parseFloat(el && el.step);
    if (Number.isFinite(step) && step > 0 && step < 1) {
      const t = String(step);
      const i = t.indexOf(".");
      if (i >= 0) return t.length - i - 1;
    }
    if (Number.isFinite(got) && got !== Math.floor(got)) {
      const s = String(got);
      const i = s.indexOf(".");
      if (i >= 0) return s.length - i - 1;
    }
    return 2;
  }

  function setInput(el, v) {
    const str = String(v);
    try {
      if (el.step && el.step !== "any") el.step = "any";
    } catch (_) {}
    try {
      el.focus();
      if (typeof el.select === "function") el.select();
    } catch (_) {}
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (proto && proto.set) proto.set.call(el, str);
    else el.value = str;
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: str, inputType: "insertReplacementText" }));
    } catch (_) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function readNum(el) {
    return parseFloat(String((el && el.value) || "").replace(/[^0-9.]/g, ""));
  }

  function nearStake(got, want) {
    if (!Number.isFinite(got) || !Number.isFinite(want)) return false;
    return Math.abs(got - want) <= Math.max(1e-6, Math.abs(want) * 0.03, 5e-4);
  }

  function fillStake(el, stake) {
    const want = round8(stake);
    const tries = [...new Set([stakeText(want), want.toFixed(3), want.toFixed(2)])];
    for (const t of tries) {
      setInput(el, t);
      const got = readNum(el);
      if (nearStake(got, want)) return { ok: true, amount: got };
    }
    const got = readNum(el);
    if (!Number.isFinite(got) || got <= 0) {
      return { ok: false, why: `amount-mismatch ${got} != ${want}` };
    }
    const snapped = roundTo(want, fieldDecimals(el, got));
    if (snapped <= 0) return { ok: false, why: `amount-mismatch ${got} != ${want}` };
    setInput(el, stakeText(snapped));
    const final = readNum(el);
    if (nearStake(final, snapped)) {
      return { ok: true, amount: final, snapped: want !== snapped };
    }
    return { ok: false, why: `amount-mismatch ${final} != ${want}` };
  }

  function readCountdown() {
    const t = (document.body && document.body.innerText || "").toLowerCase();
    const m =
      t.match(/start(?:s|ing)?\s+in\s*(\d+(?:\.\d+)?)/i) ||
      t.match(/begin(?:s|ning)?\s+in\s*(\d+(?:\.\d+)?)/i) ||
      t.match(/next\s+round\s+in\s*(\d+(?:\.\d+)?)/i);
    return m ? parseFloat(m[1]) : null;
  }

  function detectPhase(cd, live) {
    if (findMainBetButton()) return "betting";
    if (cd != null) return "betting";
    if (live != null && live > 1.12) return "flying";
    return "unknown";
  }

  function readLiveMult() {
    const cashout = Number(engine.config.cashout) || 1.45;
    let best = null;
    const els = document.querySelectorAll("div, span");
    for (const el of els) {
      if (el.offsetParent === null) continue;
      const t = (el.innerText || "").trim();
      if (!/^\d+\.\d{2}x$/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 48 || r.height < 28 || r.top < 80) continue;
      const v = parseFloat(t);
      if (v < 1) continue;
      const area = r.width * r.height;
      if (Math.abs(v - cashout) < 0.021 && area < 14000) continue;
      if (!best || area > best.area) best = { v, area };
    }
    return best ? best.v : null;
  }

  function readChips() {
    const xRe = /^(\d+\.\d+)\s*[x×]$/i;
    const idRe = /^(\d{5,10})$/;
    const cash2 = round2(engine.config.cashout);
    const found = new Map();
    const els = document.querySelectorAll("div, span, a, p, b");
    for (const el of els) {
      if (el.offsetParent === null) continue;
      if (el.closest("input,label,form,textarea,[role='dialog']")) continue;
      const raw = (el.innerText || "").trim();
      if (!raw || raw.length > 48) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > 160 || r.height > 64 || r.width < 6 || r.width > 180) continue;
      const t = raw.replace(/\s+/g, " ");
      let id = null;
      let v = null;
      let mm = t.match(/^(\d{5,10})\s+(\d+\.\d+)\s*[x×]$/i);
      if (mm) {
        id = Number(mm[1]);
        v = parseFloat(mm[2]);
      } else if (xRe.test(t) && el.children.length === 0) {
        v = parseFloat(t);
        let sib = el.previousElementSibling;
        for (let i = 0; i < 5 && sib && !id; i++) {
          if (idRe.test((sib.innerText || "").trim())) id = Number((sib.innerText || "").trim());
          sib = sib.previousElementSibling;
        }
        if (!id) {
          const p = el.parentElement;
          const pt = p ? (p.innerText || "").replace(/\s+/g, " ").trim() : "";
          if (p && pt.length <= 40) {
            const pm = pt.match(/^(\d{5,10})\s+(\d+\.\d+)\s*[x×]$/i) || pt.match(/(\d{5,10})/);
            if (pm) id = Number(pm[1]);
          }
        }
      } else if (idRe.test(t) && el.children.length === 0) {
        id = Number(t);
        let sib = el.nextElementSibling;
        for (let i = 0; i < 5 && sib && v == null; i++) {
          const xm = (sib.innerText || "").trim().match(xRe);
          if (xm) v = parseFloat(xm[1]);
          sib = sib.nextElementSibling;
        }
      }
      if (id && v >= 1 && v < 1e6) {
        const prev = found.get(id);
        const area = r.width * r.height;
        const cashish = Math.abs(round2(v) - cash2) <= 0.03;
        if (!prev) {
          found.set(id, { id, v, area, cashish });
        } else if (prev.cashish && !cashish) {
          found.set(id, { id, v, area, cashish });
        } else if (prev.cashish === cashish && area < prev.area) {
          found.set(id, { id, v, area, cashish });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.id - b.id).slice(-24);
  }

  function maxChipId(chips) {
    return chips.reduce((m, c) => Math.max(m, c.id || 0), 0);
  }

  function parseMoney(text) {
    const s = String(text || "").replace(/,/g, "").replace(/\s+/g, " ").trim();
    if (!s || s.length > 28) return null;
    if (/\d+\.\d+\s*x/i.test(s)) return null;
    const m =
      s.match(/\$\s*(\d+(?:\.\d+)?)/) ||
      s.match(/^(\d+(?:\.\d+)?)\s*(?:usdt|usd)$/i) ||
      s.match(/^(\d+\.\d{2,8})$/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null;
  }

  function inTopBar(el) {
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 8 && r.height < 56 && r.top >= 0 && r.top < 88;
  }

  function readBalance() {
    const deposit = [...document.querySelectorAll("button, a, div, span")].find((el) => {
      return /^deposit$/i.test(normText(el)) && el.offsetParent !== null && inTopBar(el);
    });
    if (deposit) {
      const dr = deposit.getBoundingClientRect();
      const cands = [];
      let root = deposit.parentElement;
      for (let depth = 0; depth < 8 && root; depth++) {
        for (const el of root.querySelectorAll("div, span, p, b, strong")) {
          if (el.closest('[role="dialog"]')) continue;
          const r = el.getBoundingClientRect();
          if (!inTopBar(el)) continue;
          if (r.right > dr.left + 12) continue;
          const t = (el.innerText || "").trim();
          if (!t || t.length > 24 || /deposit/i.test(t)) continue;
          const v = parseMoney(t);
          if (v == null) continue;
          cands.push({ v, dist: dr.left - r.right, len: t.length });
        }
        root = root.parentElement;
      }
      if (cands.length) {
        cands.sort((a, b) => a.dist - b.dist || a.len - b.len);
        return cands[0].v;
      }
    }

    const top = [];
    for (const el of document.querySelectorAll("div, span, p, b, strong")) {
      if (!inTopBar(el)) continue;
      const t = (el.innerText || "").trim();
      if (!t || t.length > 20) continue;
      if (!/\$|usdt/i.test(t)) continue;
      const v = parseMoney(t);
      if (v == null) continue;
      top.push({ v, x: el.getBoundingClientRect().left });
    }
    if (top.length) {
      top.sort((a, b) => b.x - a.x);
      return top[0].v;
    }
    return null;
  }

  function syncStartFromWallet(bal) {
    if (bal == null) return;
    const start = Number(engine.config.start_balance) || 0;
    const book = start + engine.state.session_pnl;
    if (start === 0) {
      engine.setStartBalance(bal);
      return;
    }
    if (bal > book + 0.05) {
      engine.setStartBalance(Math.round((bal - engine.state.session_pnl) * 1e8) / 1e8);
    }
  }

  function betButtonReady() {
    return !!findMainBetButton();
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function inputNearLabel(re) {
    const nodes = [...document.querySelectorAll("label, div, span, p")];
    for (const el of nodes) {
      const t = normText(el);
      if (!t || t.length > 28 || !re.test(t)) continue;
      if (!visible(el) || inHeader(el)) continue;
      let root = el;
      for (let i = 0; i < 5 && root; i++) {
        const inp = root.querySelector && root.querySelector("input:not([disabled])");
        if (inp && visible(inp) && !inHeader(inp)) return inp;
        root = root.parentElement;
      }
    }
    return null;
  }
  function clickManualTab() {
    const tabs = [...document.querySelectorAll('[role="tab"], button, a')];
    const manual = tabs.find((el) => /^manual$/i.test(normText(el)) && visible(el));
    if (!manual) return;
    const sel = (manual.getAttribute("aria-selected") || "") + " " + (manual.className || "");
    if (/true|active|selected/i.test(sel)) return;
    manual.click();
  }

  function clickEl(el) {
    try {
      el.click();
    } catch (_) {}
  }

  function mainAmountInput(btn) {
    const limit = sideBetLeft();
    const br = btn.getBoundingClientRect();
    const cands = [...document.querySelectorAll("input")].filter(isFillableInput).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left < limit && r.left < br.right + 24;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const da = Math.abs(a.getBoundingClientRect().top - br.bottom);
      const db = Math.abs(b.getBoundingClientRect().top - br.bottom);
      return da - db;
    });
    return cands[0];
  }

  function mainCashoutInput(btn, amountEl) {
    const limit = sideBetLeft();
    const br = btn.getBoundingClientRect();
    const labeled = [...document.querySelectorAll("input")].filter((el) => {
      if (el === amountEl || !isFillableInput(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.left >= limit) return false;
      let n = el;
      for (let i = 0; i < 5 && n; i++) {
        const t = (n.innerText || "").toLowerCase();
        if (/auto\s*cashout|cash\s*out/.test(t) && t.length < 60) return true;
        n = n.parentElement;
      }
      return false;
    });
    return labeled.find((el) => el.getBoundingClientRect().left < br.right + 40) || null;
  }

  function panelInputs(btn) {
    const amount = mainAmountInput(btn);
    return amount ? [amount] : [];
  }

  function placeBet(stake, cashout) {
    dismissCookies();
    clickManualTab();
    const btn = findMainBetButton();
    if (!btn) return { ok: false, why: "no-bet-button" };
    const amount = mainAmountInput(btn);
    if (!amount) return { ok: false, why: "no-enabled-input" };
    const cash = mainCashoutInput(btn, amount);
    const filled = fillStake(amount, stake);
    if (cash && cash !== amount) setInput(cash, String(cashout));
    const confirmed = fillStake(amount, stake);
    if (!confirmed.ok) return confirmed;
    clickEl(btn);
    return { ok: true, label: normText(btn), amount: confirmed.amount, snapped: !!confirmed.snapped };
  }

  function parseWsCrash(text) {
    if (!text) return null;
    const nums = [];
    try {
      const jsonish = text.replace(/^[\d]+/, "");
      const found = jsonish.match(/"(?:crash|bust|multiplier|point|crashPoint)"\s*:\s*([\d.]+)/gi);
      if (found) {
        for (const f of found) {
          const v = parseFloat(f.split(":").pop());
          if (v >= 1 && v < 1e6) nums.push(v);
        }
      }
    } catch (_) {}
    const m = text.match(/(\d+\.\d{2})\s*x/i);
    if (m) nums.push(parseFloat(m[1]));
    return nums.length ? nums[nums.length - 1] : null;
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.source !== "bc-crash-bot") return;
    if (d.type === "game_item") {
      onGameItem(Number(d.id), parseFloat(d.crash));
      return;
    }
    if (d.type === "ws") {
      const crash = parseWsCrash(d.data);
      if (crash != null && bot.pending) {
        bot.pending.wsCrash = crash;
        bot.pending.wsTs = Date.now();
      }
    }
  });

  function onGameItem(id, crash) {
    if (!id || !Number.isFinite(crash) || crash < 1) return;
    const prev = bot.lastGameItem;
    if (prev && prev.id === id) {
      bot.lastGameItem = { id, crash, ts: Date.now() };
      return;
    }
    bot.lastGameItem = { id, crash, ts: Date.now() };
    const p = bot.pending;
    if (!p) {
      applyRestRound(id);
      return;
    }
    if (id <= pendingMinId(p)) return;
    const oldest = oldestNewChip(p);
    if (oldest) {
      p.gameId = oldest.id;
      p.gameCrash = oldest.v;
    } else if (id === pendingMinId(p) + 1) {
      p.gameId = id;
      p.gameCrash = crash;
    } else {
      return;
    }
    p.sawRound = true;
    settle();
  }

  function canPlace() {
    if (!bot.betting || bot.pending || bot.dead || bot.placing) return false;
    if (engine.state.mode === Mode.RESTING || engine.state.mode === Mode.STOPPED) return false;
    if (Date.now() < (bot.placeAfter || 0)) return false;
    if (Date.now() - bot.lastPlaceFail <= 120) return false;
    return betButtonReady();
  }

  function tryPlace() {
    if (!canPlace()) return;
    if (engine.state.mode === Mode.STOPPED) {
      bot.betting = false;
      log(engine.state.message);
      return;
    }
    const nxt = engine.nextBet();
    if (!nxt) {
      log(engine.state.message);
      return;
    }
    const bal = readBalance();
    if (bal != null && nxt.stake > bal + 1e-9) {
      engine._stop(`Can't afford next stake ${nxt.stake} (balance ${bal}) — bot stopped`);
      bot.betting = false;
      log(engine.state.message);
      return;
    }
    const chips = snapshotHistory();
    const maxChip = maxChipId(chips);
    const lockId = Math.max(bot.settledGameId || 0, maxChip);
    bot.placing = true;
    bot.pending = {
      stake: nxt.stake,
      cashout: nxt.cashout,
      placedAt: Date.now(),
      maxId: maxChip,
      maxGameId: lockId,
      skipNextGameItem: false,
      roundSeq: bot.roundSeq,
      balAtPlace: bal,
      sawRound: false,
    };
    const placed = placeBet(nxt.stake, nxt.cashout);
    if (!placed.ok) {
      bot.pending = null;
      bot.placing = false;
      const soft = placed.why === "no-bet-button" || placed.why === "no-enabled-input";
      if (!soft) bot.lastPlaceFail = Date.now();
      if (!bot.lastPlaceFailLog || Date.now() - bot.lastPlaceFailLog > 2000) {
        bot.lastPlaceFailLog = Date.now();
        log(`place_bet fail: ${placed.why}`);
      }
      return;
    }
    const actual = Number.isFinite(placed.amount) ? round8(placed.amount) : nxt.stake;
    if (!nearStake(actual, nxt.stake)) {
      if (engine.state.mode === Mode.RECOVERY) engine.state.recovery_stake = actual;
      else engine.state.current_stake = actual;
      log(`Stake snapped to ${actual} (wanted ${nxt.stake})`);
    }
    bot.pending.stake = actual;
    bot.didPlaceInWindow = true;
    bot.placing = false;
    log(`Bet ${actual} @ ${nxt.cashout}x placed (${placed.label || "main bet"} amt=${placed.amount ?? actual})`);
    pushBetLog({ kind: "bet", stake: actual, cashout: nxt.cashout });
    const instant = oldestNewChip(bot.pending);
    if (instant) {
      bot.pending.gameId = instant.id;
      bot.pending.gameCrash = instant.v;
      settle();
    }
  }

  function pendingMinId(p) {
    return Math.max(p.maxId || 0, p.maxGameId || 0);
  }

  function snapshotHistory() {
    const chips = readChips();
    if (!chips.length) return chips;
    const newest = chips.reduce((a, b) => (a.id > b.id ? a : b));
    if (!bot.lastGameItem || newest.id > bot.lastGameItem.id) {
      bot.lastGameItem = { id: newest.id, crash: newest.v, ts: Date.now() };
    }
    return chips;
  }

  function oldestNewChip(p) {
    const minId = pendingMinId(p);
    const newer = snapshotHistory()
      .filter((c) => c.id > minId)
      .sort((a, b) => a.id - b.id);
    return newer[0] || null;
  }

  function resultChip(p) {
    return oldestNewChip(p);
  }

  function settle() {
    const p = bot.pending;
    if (!p) return;
    const age = (Date.now() - p.placedAt) / 1000;
    const cash2 = round2(p.cashout);
    const expected = pendingMinId(p) + 1;
    const next = resultChip(p);

    let crash = null;
    let crashId = null;
    if (next) {
      crash = next.v;
      crashId = next.id;
      if (
        p.gameId === next.id &&
        p.gameCrash != null &&
        Math.abs(round2(next.v) - cash2) <= 0.03 &&
        Math.abs(round2(p.gameCrash) - cash2) > 0.03
      ) {
        crash = p.gameCrash;
      }
    } else if (p.gameId === expected && p.gameCrash != null) {
      crash = p.gameCrash;
      crashId = p.gameId;
    }

    if (crash == null) {
      if (age >= 180) {
        log("Settle timeout — no crash result after 180s, dropped pending");
        bot.pending = null;
      }
      return;
    }

    const crash2 = round2(crash);
    let won = null;
    if (crash2 + 1e-9 < cash2) {
      won = false;
    } else {
      won = true;
    }

    const source = `${crashId || "?"} ${crash2}x ${won ? ">=" : "<"} ${cash2}x`;
    engine.onBetResult(won, p.stake, crash);
    log(`${won ? "Win" : "Lose"} (${source}) | ${engine.state.message}`);
    const last = engine.state.history[engine.state.history.length - 1];
    pushBetLog({
      kind: won ? "win" : "lose",
      stake: p.stake,
      profit: last ? last.profit : won ? round8(p.stake * (p.cashout - 1)) : round8(-p.stake),
      crash: crash2,
      crashId: crashId || null,
    });
    bot.pending = null;
    bot.didPlaceInWindow = false;
    bot.settledGameId = crashId || (bot.lastGameItem && bot.lastGameItem.id) || 0;
    bot.placeAfter = Date.now() + (won ? 80 : 0);
    if (engine.state.mode === Mode.RESTING) bot.lastRestGameId = bot.settledGameId;
    if (engine.state.mode === Mode.STOPPED) bot.betting = false;
  }

  function applyRestRound(id) {
    if (engine.state.mode !== Mode.RESTING || bot.pending) return false;
    const gid = Number(id);
    if (!gid || gid === bot.lastRestGameId) return false;
    if (gid <= (bot.lastRestGameId || bot.settledGameId || 0)) return false;
    bot.lastRestGameId = gid;
    engine.onRoundSkipped();
    log(engine.state.message);
    return true;
  }

  function tickRest() {
    if (engine.state.mode !== Mode.RESTING || bot.pending) return;
    const minId = bot.lastRestGameId || bot.settledGameId || 0;
    const newer = readChips()
      .filter((c) => c.id > minId)
      .sort((a, b) => a.id - b.id);
    for (const c of newer) {
      if (engine.state.mode !== Mode.RESTING) break;
      applyRestRound(c.id);
    }
  }

  function tick() {
    if (!extAlive()) {
      die();
      return;
    }
    if (bot.tickBusy) return;
    bot.tickBusy = true;
    try {
      syncStartFromWallet(readBalance());
      const live = readLiveMult();
      if (live != null) engine.state.last_multiplier_seen = live;

      const cd = readCountdown();
      const phase = detectPhase(cd, live);
      if (phase !== bot.lastPhase) {
        log(`phase ${bot.lastPhase} -> ${phase} live=${live ?? "—"} cd=${cd ?? "—"}`);
      }

      snapshotHistory();
      if (bot.pending) settle();
      tickRest();
      if (canPlace()) tryPlace();

      bot.lastPhase = phase;
      renderOverlay();
    } catch (err) {
      if (/invalidat/i.test(String(err && err.message ? err.message : err))) {
        die();
        return;
      }
      console.error("[BC Bot] tick", err);
    } finally {
      bot.tickBusy = false;
    }
  }

  function status() {
    const snap = engine.snapshot();
    snap.betting_enabled = bot.betting;
    snap.pending_stake = bot.pending ? bot.pending.stake : null;
    snap.site_message = bot.siteMessage;
    snap.live_multiplier = engine.state.last_multiplier_seen;
    snap.logs = bot.logs.slice(-80);
    snap.bet_log = bot.betLog.slice(-100);
    snap.config = { ...engine.config };
    return snap;
  }

  function renderOverlay() {
    let el = document.getElementById("bc-crash-bot-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "bc-crash-bot-overlay";
      document.documentElement.appendChild(el);
    }
    const s = engine.snapshot();
    const live = engine.state.last_multiplier_seen;
    el.innerHTML = `
      <div class="title">BC Crash Bot v${extVersion}</div>
      <div class="row"><span class="k">Betting</span><span class="v ${bot.betting ? "on" : "off"}">${bot.betting ? "ON" : "off"}</span></div>
      <div class="row"><span class="k">Mode</span><span class="v">${s.mode}</span></div>
      <div class="row"><span class="k">Stake</span><span class="v">${bot.pending ? bot.pending.stake : (s.mode === "recovery" ? s.recovery_stake : s.current_stake)}</span></div>
      <div class="row"><span class="k">Live</span><span class="v">${live != null ? live.toFixed(2) + "x" : "—"}</span></div>
      <div class="row"><span class="k">W / L</span><span class="v">${s.wins} / ${s.losses}</span></div>
      <div class="row"><span class="k">P/L</span><span class="v">${s.session_pnl}</span></div>
      <div class="msg">${bot.siteMessage}</div>
    `;
  }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!extAlive()) {
        die();
        return;
      }
      if (!msg || !msg.type) return;
      if (msg.type === "GET_STATUS") {
        sendResponse(status());
        return;
      }
      if (msg.type === "START_BET") {
        bot.betting = true;
        bot.placeAfter = 0;
        if (engine.state.mode === Mode.STOPPED) {
          engine.resetToBase("Betting ON");
        }
        const bal = readBalance();
        if (bal != null && (engine.config.start_balance === 0 || engine.state.bets_placed === 0)) {
          engine.setStartBalance(bal);
        }
        log("Betting ON — will place on this/next window");
        tryPlace();
        sendResponse(status());
        return;
      }
      if (msg.type === "STOP_BET") {
        bot.betting = false;
        log("Betting OFF");
        sendResponse(status());
        return;
      }
      if (msg.type === "UPDATE_CONFIG") {
        engine.updateConfig(msg.config || {});
        chrome.storage.local.set({ config: engine.config });
        log("Settings saved");
        sendResponse(status());
        return;
      }
      if (msg.type === "RESET") {
        bot.pending = null;
        bot.betLog = [];
        bot.logs = [];
        engine.reset();
        const bal = readBalance();
        if (bal != null) engine.setStartBalance(bal);
        log(engine.state.message);
        sendResponse(status());
      }
    });

    chrome.storage.local.get("config", (data) => {
      if (!extAlive()) return;
      if (data && data.config) engine.updateConfig(data.config);
      const bal = readBalance();
      if (bal != null) engine.setStartBalance(bal);
      renderOverlay();
      log("Ready on crash page. Click Start bet in the extension popup.");
    });

    tickTimer = setInterval(tick, 120);
    window.__bcCrashBotLoaded = true;
  }

  try {
    boot();
  } catch (err) {
    console.error("[BC Bot] boot failed", err);
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      sendResponse({
        mode: "stopped",
        betting_enabled: false,
        site_message: "Bot failed to start: " + err,
        message: String(err),
        current_stake: "—",
        session_pnl: 0,
        wins: 0,
        losses: 0,
      });
    });
  }
})();
