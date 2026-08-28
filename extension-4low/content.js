(() => {
  function boot() {
    if (window.__bcCrash4LowLoaded) return;

    let botConfig = defaultBotConfig();
    const streakEngine = new StrategyEngine(botConfig.streak_low);
    const sgEngine = new SingleGreenEngine(botConfig.single_green);

  const bot = {
    betting: false,
    pending: null,
    armedStrategy: null,
    lastPhase: "unknown",
    lastCd: null,
    roundSeq: 0,
    siteMessage: "Extension loaded. Open the popup and click Start bet.",
    logs: { streak_low: [], single_green: [], system: [] },
    betLog: { streak_low: [], single_green: [] },
    lastPlaceFail: 0,
    didPlaceInWindow: false,
    lastGameItem: null,
    lastSkipLog: 0,
    lastRestGameId: 0,
    placeAfter: 0,
    dead: false,
    placing: false,
    tickBusy: false,
    lastSettleAt: 0,
    bannerObs: null,
    lastGameId: 0,
    liveTimer: null,
    awaitingBet: false,
    armedAtId: 0,
    placePump: null,
    verifying: null,
  };

  let extVersion = "1.1.3";
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
    syncBettingFlag();
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (bot.liveTimer) {
      clearInterval(bot.liveTimer);
      bot.liveTimer = null;
    }
    stopPlacePump();
    window.__bcCrash4LowLoaded = false;
  }

  function isEnabled(key) {
    if (key === "streak_low") return botConfig.enabled_streak_low !== false;
    if (key === "single_green") return !!botConfig.enabled_single_green;
    return false;
  }

  function engineFor(key) {
    return key === "single_green" ? sgEngine : streakEngine;
  }

  function combinedPnl() {
    let p = 0;
    if (isEnabled("streak_low")) p += Number(streakEngine.state.session_pnl) || 0;
    if (isEnabled("single_green")) p += Number(sgEngine.state.session_pnl) || 0;
    return p;
  }

  function anyStrategyStopped() {
    if (isEnabled("streak_low") && streakEngine.state.mode === Mode.STOPPED) return true;
    if (isEnabled("single_green") && sgEngine.state.mode === SgMode.STOPPED) return true;
    return false;
  }

  function activeStrategies() {
    const out = [];
    if (isEnabled("streak_low") && streakEngine.state.mode !== Mode.STOPPED) out.push("streak_low");
    if (isEnabled("single_green") && sgEngine.state.mode !== SgMode.STOPPED) out.push("single_green");
    return out;
  }

  function pickBetIntent() {
    const intents = [];
    if (isEnabled("streak_low") && streakEngine.state.mode !== Mode.STOPPED && streakEngine.shouldBet()) {
      const bet = streakEngine.nextBet();
      if (bet) intents.push({ key: "streak_low", bet });
    }
    if (isEnabled("single_green") && sgEngine.state.mode !== SgMode.STOPPED && sgEngine.shouldBet()) {
      const bet = sgEngine.nextBet();
      if (bet) intents.push({ key: "single_green", bet });
    }
    if (intents.length > 1) {
      log(`Both strategies armed — using ${intents[0].key}`, "system");
    }
    return intents[0] || null;
  }

  function log(msg, channel) {
    const key = channel === "streak_low" || channel === "single_green" ? channel : "system";
    const prefix = key === "streak_low" ? "4-Low" : key === "single_green" ? "SG" : "Bot";
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    bot.logs[key].push(line);
    if (bot.logs[key].length > 80) bot.logs[key].shift();
    bot.siteMessage = `[${prefix}] ${msg}`;
    console.log(`[BC ${prefix}]`, msg);
    renderOverlay();
  }

  function pushBetLog(entry, strategy) {
    const key = strategy === "single_green" ? "single_green" : "streak_low";
    bot.betLog[key].push({
      t: new Date().toLocaleTimeString(),
      ...entry,
    });
    if (bot.betLog[key].length > 150) bot.betLog[key].shift();
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

  function syncBettingFlag() {
    try {
      chrome.storage.local.set({ betting_enabled: !!bot.betting });
      chrome.runtime.sendMessage({ type: bot.betting ? "BETTING_ON" : "BETTING_OFF" });
    } catch (_) {}
  }

  function syncAwaitingFlag() {
    try {
      chrome.storage.local.set({ awaiting_bet: !!bot.awaitingBet });
      chrome.runtime.sendMessage({ type: "AWAITING_BET", value: !!bot.awaitingBet });
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isMainPlacedBet() {
    const limit = sideBetLeft();
    for (const b of allBetControls()) {
      if (!visible(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.left >= limit) continue;
      const t = normText(b).toLowerCase();
      if (/\bcancel\b/.test(t) && (/\bbet\b/.test(t) || t.length < 16)) return true;
      if (/\bplaced\b/.test(t) && /\bbet\b/.test(t)) return true;
    }
    return false;
  }

  async function waitForBetVerified(stake, balBefore, timeoutMs) {
    const want = round8(stake);
    const deadline = Date.now() + (timeoutMs || 3500);
    while (Date.now() < deadline) {
      if (isMainPlacedBet()) return { ok: true };
      if (!findMainBetButton() && isMainPlacedBet()) return { ok: true };
      if (balBefore != null) {
        const bal = readBalance();
        if (bal != null && bal < balBefore - want * 0.85 + 1e-6) {
          return { ok: true, balance: bal };
        }
      }
      await sleep(120);
    }
    return { ok: false, why: "verify-timeout" };
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

  function parseMultText(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    const m = t.match(/^(\d+(?:\.\d+)?)\s*[x×]$/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (!Number.isFinite(v) || v < 1 || v >= 1e6) return null;
    return v;
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
    const cashout = bot.pending
      ? Number(bot.pending.cashout) || 2
      : Math.max(
          Number(streakEngine.config.cashout) || 1.9,
          Number(sgEngine.config.cashout) || 2
        );
    let best = null;
    const els = document.querySelectorAll("div, span, b, p, h1, h2");
    for (const el of els) {
      if (el.offsetParent === null) continue;
      const v = parseMultText(el.innerText || "");
      if (v == null) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 22 || r.top < 70) continue;
      const area = r.width * r.height;
      if (Math.abs(v - cashout) < 0.021 && area < 14000) continue;
      if (!best || area > best.area) best = { v, area };
    }
    return best ? best.v : null;
  }

  function findRecentList(doc) {
    const d = doc || document;
    return (
      d.querySelector("div#crash-banner > div > div.grid") ||
      d.querySelector("#crash-banner .grid") ||
      d.querySelector('[id*="crash-banner"] .grid') ||
      d.querySelector("#crash-banner")
    );
  }

  function parseChip(el) {
    if (!el) return null;
    const block = el.querySelector ? el.querySelector("span.flex.flex-col") || el : el;
    const spans = block.querySelectorAll ? block.querySelectorAll("span") : [];
    let gameId = 0;
    let gameValue = NaN;
    if (spans.length >= 2) {
      gameId = parseInt(spans[0].textContent, 10);
      gameValue = parseFloat(String(spans[1].textContent).replace(/x/i, ""));
    }
    if (!gameId || !(gameValue > 0)) {
      const text = String(el.textContent || "").replace(/\s+/g, " ");
      const match = text.match(/(\d{6,})\D+([\d.]+)/);
      if (match) {
        gameId = parseInt(match[1], 10);
        gameValue = parseFloat(match[2]);
      }
    }
    if (!gameId || !(gameValue > 0)) return null;
    return { id: gameId, v: Number(gameValue.toFixed(2)), value: Number(gameValue.toFixed(2)), area: 1, cashish: false };
  }

  function collectBannerGames() {
    const seen = {};
    const games = [];
    const add = (parsed) => {
      if (!parsed || seen[parsed.id]) return;
      seen[parsed.id] = true;
      games.push(parsed);
    };
    const scanDoc = (doc) => {
      const roots = [];
      const recentList = findRecentList(doc);
      if (recentList) roots.push(recentList);
      const banner = doc.querySelector("#crash-banner");
      if (banner && banner !== recentList) roots.push(banner);
      roots.forEach((root) => {
        Array.from(root.querySelectorAll("span.flex.flex-col")).forEach((el) => add(parseChip(el)));
        Array.from(root.children || []).forEach((el) => add(parseChip(el)));
      });
    };
    scanDoc(document);
    try {
      document.querySelectorAll("iframe").forEach((frame) => {
        try {
          if (frame.contentDocument) scanDoc(frame.contentDocument);
        } catch (_) {}
      });
    } catch (_) {}
    return games.sort((a, b) => a.id - b.id);
  }

  function onNewBannerGame(id, value) {
    bot.lastGameItem = { id, crash: value, ts: Date.now() };
    const p = bot.pending;
    if (p) {
      const expected = pendingMinId(p) + 1;
      if (id < expected) return;
      if (id === expected) {
        p.gameId = id;
        p.gameCrash = value;
        p.sawRound = true;
        bot.awaitingBet = false;
        settle();
        return;
      }
      log(`Banner gap ${expected} → ${id} ${value}x — pending counted as lose`, p.strategy || "streak_low");
      p.gameId = expected;
      p.gameCrash = 1;
      p.sawRound = true;
      bot.awaitingBet = false;
      settle();
      if (p.strategy === "streak_low" && streakEngine.state.mode === Mode.SKIPPING) observeRound(value, id);
      return;
    }
    observeRound(value, id);
    if (bot.awaitingBet) tryPlace();
  }

  function sendGameValueUpdates() {
    const games = collectBannerGames();
    if (!games.length) return;
    if (!bot.lastGameId) {
      bot.lastGameId = games[games.length - 1].id;
      return;
    }
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      if (!g.id || g.id <= bot.lastGameId) continue;
      bot.lastGameId = g.id;
      onNewBannerGame(g.id, g.v);
    }
    if (bot.awaitingBet && !bot.pending) tryPlace();
  }

  function bannerTailLows() {
    const games = collectBannerGames();
    const low = Number(streakEngine.config.low_below) || 1.45;
    const tail = [];
    for (let i = games.length - 1; i >= 0; i--) {
      const v = round2(games[i].v);
      if (v + 1e-9 < low) tail.unshift(v);
      else break;
    }
    return { games, tail };
  }

  function applyBannerTailStreak() {
    const { games, tail } = bannerTailLows();
    if (games.length) {
      const newest = games[games.length - 1].id;
      if (!bot.lastGameId || newest > bot.lastGameId) bot.lastGameId = newest;
    }
    if (isEnabled("streak_low")) {
      streakEngine.setWatchingStreak(tail.length, tail);
    }
    if (isEnabled("single_green")) {
      sgEngine.replayGames(games.map((g) => ({ id: g.id, value: g.v })));
    }
    bot.awaitingBet = false;
    bot.armedStrategy = null;
    bot.armedAtId = 0;
    if (bot.betting) {
      const intent = pickBetIntent();
      if (intent && games.length) {
        bot.armedStrategy = intent.key;
        armBet(games[games.length - 1].id);
      }
    }
    const shown = tail.length ? tail.map((v) => v.toFixed(2)).join("  ") : "—";
    const need = Number(streakEngine.config.streak_needed) || 4;
    log(`Banner lows ${tail.length}/${need} [${shown}]`, "streak_low");
    if (isEnabled("single_green")) log(sgEngine.state.message, "single_green");
  }

  function startLiveUpdates() {
    if (bot.liveTimer) return;
    sendGameValueUpdates();
    bot.liveTimer = setInterval(sendGameValueUpdates, 200);
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
    const combined = combinedPnl();
    const start =
      (Number(streakEngine.config.start_balance) || 0) +
      (Number(sgEngine.config.start_balance) || 0);
    const book = start + combined;
    if (start === 0) {
      const half = bal / (activeStrategies().length || 1);
      if (isEnabled("streak_low")) streakEngine.setStartBalance(half);
      if (isEnabled("single_green")) sgEngine.setStartBalance(bal - half);
      return;
    }
    if (bal > book + 0.05) {
      const delta = bal - combined;
      const n = activeStrategies().length || 1;
      const each = Math.round((delta / n) * 1e8) / 1e8;
      if (isEnabled("streak_low")) {
        streakEngine.setStartBalance(
          Math.round((each - streakEngine.state.session_pnl) * 1e8) / 1e8
        );
      }
      if (isEnabled("single_green")) {
        sgEngine.setStartBalance(
          Math.round((each - sgEngine.state.session_pnl) * 1e8) / 1e8
        );
      }
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

  function canPlace() {
    if (!bot.betting || bot.pending || bot.dead || bot.placing || bot.verifying) return false;
    if (!bot.awaitingBet || !bot.armedStrategy) return false;
    const eng = engineFor(bot.armedStrategy);
    if (bot.armedStrategy === "streak_low") {
      if (streakEngine.state.mode === Mode.SKIPPING || streakEngine.state.mode === Mode.STOPPED) return false;
    } else if (sgEngine.state.mode === SgMode.STOPPED) return false;
    if (!eng.shouldBet()) return false;
    if (!bot.lastGameId) return false;
    if (Date.now() < (bot.placeAfter || 0)) return false;
    const games = collectBannerGames();
    if (games.length && bot.armedAtId && games[games.length - 1].id > bot.armedAtId) return false;
    return betButtonReady();
  }

  function armBet(id, strategy) {
    bot.awaitingBet = true;
    bot.armedStrategy = strategy || bot.armedStrategy || pickBetIntent()?.key || "streak_low";
    bot.armedAtId = id || bot.lastGameId;
    bot.placeAfter = 0;
    syncAwaitingFlag();
    startPlacePump();
    tryPlace();
  }

  function startPlacePump() {
    if (bot.placePump) return;
    bot.placePump = setInterval(() => {
      if (!extAlive() || !bot.betting || !bot.awaitingBet || bot.pending || bot.verifying) {
        if (!bot.awaitingBet || bot.pending || bot.verifying || !bot.betting) stopPlacePump();
        return;
      }
      tryPlace();
    }, 50);
  }

  function stopPlacePump() {
    if (!bot.placePump) return;
    clearInterval(bot.placePump);
    bot.placePump = null;
  }

  async function tryPlace() {
    if (bot.verifying || bot.placing) return;
    if (!canPlace()) return;
    const strat = bot.armedStrategy || "streak_low";
    const eng = engineFor(strat);
    if (
      (strat === "streak_low" && streakEngine.state.mode === Mode.STOPPED) ||
      (strat === "single_green" && sgEngine.state.mode === SgMode.STOPPED)
    ) {
      if (!activeStrategies().length) bot.betting = false;
      log(eng.state.message, strat);
      return;
    }
    const nxt = eng.nextBet();
    if (!nxt) {
      log(eng.state.message, strat);
      return;
    }
    const bal = readBalance();
    if (bal != null && nxt.stake > bal + 1e-9) {
      eng._stop(`Can't afford next stake ${nxt.stake} (balance ${bal}) — strategy stopped`);
      bot.awaitingBet = false;
      bot.armedStrategy = null;
      stopPlacePump();
      log(eng.state.message, strat);
      if (!activeStrategies().length) bot.betting = false;
      return;
    }
    const lockId = bot.armedAtId || bot.lastGameId;
    if (!lockId) return;
    bot.placing = true;
    bot.pending = {
      strategy: strat,
      stake: nxt.stake,
      cashout: nxt.cashout,
      placedAt: Date.now(),
      maxId: lockId,
      maxGameId: lockId,
      roundSeq: bot.roundSeq,
      balAtPlace: bal,
      sawRound: false,
    };
    const pendingRef = bot.pending;
    const placed = placeBet(nxt.stake, nxt.cashout);
    if (!placed.ok) {
      bot.placing = false;
      if (bot.pending === pendingRef) bot.pending = null;
      const soft = placed.why === "no-bet-button" || placed.why === "no-enabled-input";
      if (!soft) bot.lastPlaceFail = Date.now();
      if (!bot.lastPlaceFailLog || Date.now() - bot.lastPlaceFailLog > 2000) {
        bot.lastPlaceFailLog = Date.now();
        log(`place_bet fail: ${placed.why}`, strat);
      }
      return;
    }
    bot.verifying = true;
    const verified = await waitForBetVerified(nxt.stake, bal, document.hidden ? 5000 : 3500);
    bot.verifying = false;
    bot.placing = false;
    if (!verified.ok) {
      if (bot.pending === pendingRef) bot.pending = null;
      if (!bot.lastPlaceFailLog || Date.now() - bot.lastPlaceFailLog > 3000) {
        bot.lastPlaceFailLog = Date.now();
        log(`Bet click not confirmed on site${document.hidden ? " (tab hidden)" : ""} — will retry`, strat);
      }
      return;
    }
    const actual = Number.isFinite(placed.amount) ? round8(placed.amount) : nxt.stake;
    if (bot.pending === pendingRef) {
      if (!nearStake(actual, nxt.stake)) {
        log(`Stake snapped to ${actual} (wanted ${nxt.stake})`, strat);
      }
      bot.pending.stake = actual;
    }
    bot.didPlaceInWindow = true;
    bot.awaitingBet = false;
    syncAwaitingFlag();
    stopPlacePump();
    log(`Bet ${actual} @ ${nxt.cashout}x confirmed (${placed.label || "main bet"})`, strat);
    pushBetLog({ kind: "bet", stake: actual, cashout: nxt.cashout }, strat);
  }

  function pendingMinId(p) {
    return Math.max(p.maxId || 0, p.maxGameId || 0);
  }

  function settle() {
    const p = bot.pending;
    if (!p) return;
    const age = (Date.now() - p.placedAt) / 1000;
    const cash2 = round2(p.cashout);

    if (p.gameId == null || p.gameCrash == null) {
      if (age >= 180) {
        log("Settle timeout — no crash result after 180s, dropped pending", p.strategy || "streak_low");
        bot.pending = null;
      }
      return;
    }

    const crash = p.gameCrash;
    const crashId = p.gameId;
    const crash2 = round2(crash);
    const won = !(crash2 + 1e-9 < cash2);

    const strat = p.strategy || "streak_low";
    const eng = engineFor(strat);
    const source = `${crashId || "?"} ${crash2}x ${won ? ">=" : "<"} ${cash2}x`;
    eng.onBetResult(won, p.stake, crash);
    log(`${won ? "Win" : "Lose"} (${source}) | ${eng.state.message}`, strat);
    const last = eng.state.history[eng.state.history.length - 1];
    pushBetLog(
      {
        kind: won ? "win" : "lose",
        stake: p.stake,
        profit: last ? last.profit : won ? round8(p.stake * (p.cashout - 1)) : round8(-p.stake),
        crash: crash2,
        crashId: crashId || null,
      },
      strat
    );
    bot.pending = null;
    bot.awaitingBet = false;
    bot.armedStrategy = null;
    bot.armedAtId = 0;
    stopPlacePump();
    bot.didPlaceInWindow = false;
    bot.lastSettleAt = Date.now();
    bot.settledGameId = crashId || (bot.lastGameItem && bot.lastGameItem.id) || 0;
    bot.placeAfter = 0;
    if (!activeStrategies().length) bot.betting = false;
  }

  function handleMissedRound(value, id) {
    const strat = bot.armedStrategy || "streak_low";
    log(`Missed round at ${id || "?"} ${round2(value)}x — not betting the following one`, strat);
    bot.awaitingBet = false;
    syncAwaitingFlag();
    bot.armedAtId = 0;
    bot.armedStrategy = null;
    stopPlacePump();
    if (strat === "streak_low") streakEngine.setWatchingStreak(0);
    else sgEngine.onMissedBet();
    if (isEnabled("streak_low")) {
      streakEngine.onRoundObserved(value);
      log(streakEngine.state.message, "streak_low");
    }
    if (isEnabled("single_green")) {
      sgEngine.onRoundObserved(value, id);
      log(sgEngine.state.message, "single_green");
    }
    const intent = pickBetIntent();
    if (intent) {
      bot.armedStrategy = intent.key;
      armBet(id || bot.lastGameId, intent.key);
    }
  }

  function observeRound(value, id) {
    if (!bot.betting) return;
    if (bot.awaitingBet && !bot.pending && !bot.verifying) {
      handleMissedRound(value, id);
      return;
    }
    if (isEnabled("streak_low") && streakEngine.state.mode === Mode.SKIPPING) {
      streakEngine.onRoundObserved(value);
      log(streakEngine.state.message, "streak_low");
      if (isEnabled("single_green")) {
        sgEngine.onRoundObserved(value, id);
        log(sgEngine.state.message, "single_green");
      }
      const intent = pickBetIntent();
      if (intent) {
        bot.armedStrategy = intent.key;
        armBet(id || bot.lastGameId, intent.key);
      }
      return;
    }
    if (isEnabled("streak_low")) {
      streakEngine.onRoundObserved(value);
      log(streakEngine.state.message, "streak_low");
    }
    if (isEnabled("single_green")) {
      sgEngine.onRoundObserved(value, id);
      log(sgEngine.state.message, "single_green");
    }
    const intent = pickBetIntent();
    if (intent) {
      bot.armedStrategy = intent.key;
      armBet(id || bot.lastGameId, intent.key);
    }
  }

  function watchBanner() {
    if (bot.bannerObs || bot.dead) return;
    const roots = [];
    const add = (el) => {
      if (el && roots.indexOf(el) < 0) roots.push(el);
    };
    add(findRecentList(document));
    add(document.querySelector("#crash-banner"));
    try {
      document.querySelectorAll("iframe").forEach((frame) => {
        try {
          const doc = frame.contentDocument;
          if (!doc) return;
          add(findRecentList(doc));
          add(doc.querySelector("#crash-banner"));
        } catch (_) {}
      });
    } catch (_) {}
    if (!roots.length) return;
    bot.bannerObs = new MutationObserver(() => {
      if (!extAlive()) return;
      sendGameValueUpdates();
    });
    roots.forEach((root) => {
      try {
        bot.bannerObs.observe(root, { childList: true, subtree: true, characterData: true });
      } catch (_) {}
    });
  }

  function onKeepaliveTick() {
    sendGameValueUpdates();
    if (bot.pending) settle();
    if (bot.betting && (bot.awaitingBet || bot.verifying)) tryPlace();
    else if (canPlace()) tryPlace();
    renderOverlay();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && bot.betting) onKeepaliveTick();
  });

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
      if (live != null) {
        streakEngine.state.last_multiplier_seen = live;
        sgEngine.state.last_multiplier_seen = live;
      }

      const cd = readCountdown();
      const phase = detectPhase(cd, live);
      if (phase !== bot.lastPhase) {
        log(`phase ${bot.lastPhase} -> ${phase} live=${live ?? "—"} cd=${cd ?? "—"}`, "system");
      }

      if (bot.pending) settle();
      watchBanner();
      if (canPlace()) tryPlace();

      bot.lastPhase = phase;
      renderOverlay();
    } catch (err) {
      if (/invalidat/i.test(String(err && err.message ? err.message : err))) {
        die();
        return;
      }
      console.error("[BC 4-Low] tick", err);
    } finally {
      bot.tickBusy = false;
    }
  }

  function status() {
    const sl = streakEngine.snapshot();
    const sg = sgEngine.snapshot();
    const combined = combinedPnl();
    let startBal = 0;
    if (isEnabled("streak_low")) startBal += Number(sl.start_balance) || 0;
    if (isEnabled("single_green")) startBal += Number(sg.start_balance) || 0;
    return {
      betting_enabled: bot.betting,
      enabled_streak_low: isEnabled("streak_low"),
      enabled_single_green: isEnabled("single_green"),
      armed_strategy: bot.armedStrategy,
      pending_stake: bot.pending ? bot.pending.stake : null,
      pending_strategy: bot.pending ? bot.pending.strategy : null,
      site_message: strategyStatusLines()
        .map((l) => `[${l.tag}] ${l.text}`)
        .join(" · ") || bot.siteMessage,
      live_multiplier: streakEngine.state.last_multiplier_seen,
      session_pnl: round8(combined),
      current_balance: round8(startBal + combined),
      streak_low: sl,
      single_green: sg,
      logs: {
        streak_low: bot.logs.streak_low.slice(-40),
        single_green: bot.logs.single_green.slice(-40),
        system: bot.logs.system.slice(-20),
      },
      bet_log_streak_low: bot.betLog.streak_low.slice(-100),
      bet_log_single_green: bot.betLog.single_green.slice(-100),
      config: { ...botConfig },
    };
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function strategyStatusLines() {
    const lines = [];
    if (isEnabled("streak_low")) lines.push({ tag: "4-Low", text: streakEngine.state.message });
    if (isEnabled("single_green")) lines.push({ tag: "SG", text: sgEngine.state.message });
    return lines;
  }

  function overlayFooterHtml() {
    const lines = strategyStatusLines();
    if (!lines.length) return `<div class="msg">${escapeHtml(bot.siteMessage)}</div>`;
    return lines
      .map(
        (l) =>
          `<div class="msg"><span class="msg-tag">${escapeHtml(l.tag)}</span> ${escapeHtml(l.text)}</div>`
      )
      .join("");
  }

  function renderOverlay() {
    let el = document.getElementById("bc-crash-4low-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "bc-crash-4low-overlay";
      document.documentElement.appendChild(el);
    }
    const sl = streakEngine.snapshot();
    const sg = sgEngine.snapshot();
    const live = streakEngine.state.last_multiplier_seen;
    const recentLows = (sl.recent_crashes || []).slice(-4).map((v) => Number(v).toFixed(2)).join(" ");
    el.innerHTML = `
      <div class="title">BC Crash Bot v${extVersion}</div>
      <div class="row"><span class="k">Betting</span><span class="v ${bot.betting ? "on" : "off"}">${bot.betting ? "ON" : "off"}</span></div>
      <div class="row"><span class="k">Armed</span><span class="v">${bot.armedStrategy || "—"}${bot.awaitingBet ? " NOW" : ""}</span></div>
      <div class="row"><span class="k">4-Low</span><span class="v">${isEnabled("streak_low") ? `${sl.low_streak}/${sl.streak_needed}` : "off"}</span></div>
      <div class="row"><span class="k">SG</span><span class="v">${isEnabled("single_green") ? `${sg.sg_count}/${sg.sg_needed}${sg.armed ? " armed" : ""}` : "off"}</span></div>
      ${isEnabled("streak_low") && recentLows ? `<div class="row lows"><span class="k">Recent</span><span class="v">${recentLows}</span></div>` : ""}
      <div class="row"><span class="k">Stake</span><span class="v">${bot.pending ? bot.pending.stake : "—"}</span></div>
      <div class="row"><span class="k">Live</span><span class="v">${live != null ? live.toFixed(2) + "x" : "—"}</span></div>
      <div class="row"><span class="k">P/L</span><span class="v">${combinedPnl()}</span></div>
      ${overlayFooterHtml()}
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
      if (msg.type === "KEEPALIVE_TICK") {
        onKeepaliveTick();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "START_BET") {
        if (!isEnabled("streak_low") && !isEnabled("single_green")) {
          log("Enable at least one strategy in the popup", "system");
          sendResponse(status());
          return;
        }
        bot.betting = true;
        bot.placeAfter = 0;
        bot.pending = null;
        bot.armedStrategy = null;
        syncBettingFlag();
        applyBannerTailStreak();
        const bal = readBalance();
        if (bal != null) {
          const n = activeStrategies().length || 1;
          const each = bal / n;
          if (isEnabled("streak_low") && (streakEngine.config.start_balance === 0 || streakEngine.state.bets_placed === 0)) {
            streakEngine.setStartBalance(each);
          }
          if (isEnabled("single_green") && (sgEngine.config.start_balance === 0 || sgEngine.state.bets_placed === 0)) {
            sgEngine.setStartBalance(each);
          }
        }
        tryPlace();
        sendResponse(status());
        return;
      }
      if (msg.type === "STOP_BET") {
        bot.betting = false;
        bot.awaitingBet = false;
        bot.armedStrategy = null;
        syncAwaitingFlag();
        syncBettingFlag();
        stopPlacePump();
        log("Betting OFF", "system");
        sendResponse(status());
        return;
      }
      if (msg.type === "UPDATE_CONFIG") {
        botConfig = normalizeBotConfig({ ...botConfig, ...(msg.config || {}) });
        streakEngine.updateConfig(botConfig.streak_low);
        sgEngine.updateConfig(botConfig.single_green);
        chrome.storage.local.set({ config: botConfig });
        log("Settings saved", "system");
        sendResponse(status());
        return;
      }
      if (msg.type === "RESET") {
        bot.pending = null;
        bot.betLog = { streak_low: [], single_green: [] };
        bot.logs = { streak_low: [], single_green: [], system: [] };
        bot.lastGameId = 0;
        bot.awaitingBet = false;
        bot.armedStrategy = null;
        bot.armedAtId = 0;
        stopPlacePump();
        streakEngine.reset();
        sgEngine.reset();
        const bal = readBalance();
        if (bal != null) {
          const n = activeStrategies().length || 1;
          const each = bal / n;
          if (isEnabled("streak_low")) streakEngine.setStartBalance(each);
          if (isEnabled("single_green")) sgEngine.setStartBalance(each);
        }
        log("Reset complete", "system");
        sendResponse(status());
      }
    });

    chrome.storage.local.get("config", (data) => {
      if (!extAlive()) return;
      if (data && data.config) {
        botConfig = normalizeBotConfig(data.config);
        streakEngine.updateConfig(botConfig.streak_low);
        sgEngine.updateConfig(botConfig.single_green);
      }
      const bal = readBalance();
      if (bal != null) {
        const n = activeStrategies().length || 1;
        const each = bal / n;
        if (isEnabled("streak_low")) streakEngine.setStartBalance(each);
        if (isEnabled("single_green")) sgEngine.setStartBalance(each);
      }
      renderOverlay();
      log("Ready — enable strategies in popup, then Start.", "system");
      startLiveUpdates();
    });

    tickTimer = setInterval(tick, 120);
    window.__bcCrash4LowLoaded = true;
  }

  try {
    boot();
  } catch (err) {
    console.error("[BC 4-Low] boot failed", err);
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
