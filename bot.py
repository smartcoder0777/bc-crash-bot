"""Control BC Crash via real Chrome (CDP). Never launches Playwright's automated browser."""

from __future__ import annotations

import asyncio
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from strategy import Mode, StrategyEngine

ROOT = Path(__file__).resolve().parent
PROFILE_DIR = ROOT / "browser_data"
CDP_PORT = 9222
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"

StatusCallback = Callable[[dict[str, Any]], None]


def _chrome_path() -> str | None:
    candidates = [
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path.home() / r"AppData\Local\Google\Chrome\Application\chrome.exe",
    ]
    for path in candidates:
        if path.is_file():
            return str(path)
    return None


def _cdp_alive() -> bool:
    try:
        with urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=1.5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


class CrashBot:
    def __init__(
        self,
        engine: StrategyEngine,
        config: dict[str, Any],
        on_status: StatusCallback | None = None,
    ):
        self.engine = engine
        self.config = config
        self.on_status = on_status or (lambda _s: None)
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._running = False
        self._context = None
        self._page = None
        self._browser = None
        self._chrome_proc: subprocess.Popen | None = None
        self._login_ready = threading.Event()
        self.awaiting_login = False
        self.betting_enabled = False
        self._refresh_balance = False
        self.live_multiplier: float | None = None
        self.site_message = "Browser not started"

    @property
    def running(self) -> bool:
        return self._running

    def status(self) -> dict[str, Any]:
        data = self.engine.snapshot()
        data.update(
            {
                "bot_running": self._running,
                "awaiting_login": self.awaiting_login,
                "betting_enabled": self.betting_enabled,
                "live_multiplier": self.live_multiplier,
                "site_message": self.site_message,
                "chrome_cdp": _cdp_alive(),
                "config": self.engine.config.to_dict(),
            }
        )
        return data

    def _emit(self) -> None:
        self.on_status(self.status())

    def ensure_real_chrome(self) -> dict[str, Any]:
        """Start real Google Chrome with remote debugging (same window for login + bot)."""
        if _cdp_alive():
            self.site_message = (
                "Real Chrome already running. Log in there if needed, then Start bot "
                "(keep this Chrome open)."
            )
            self._emit()
            return {"ok": True, "already": True}

        chrome = _chrome_path()
        if not chrome:
            return {"ok": False, "error": "Google Chrome not found."}

        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        url = self.config.get("site_url", "https://bc.game/game/crash")
        try:
            self._chrome_proc = subprocess.Popen(
                [
                    chrome,
                    f"--remote-debugging-port={CDP_PORT}",
                    f"--user-data-dir={PROFILE_DIR}",
                    "--profile-directory=Default",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--start-maximized",
                    url,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

        for _ in range(40):
            if _cdp_alive():
                self.site_message = (
                    "Real Chrome opened. Complete One-time Code login HERE, "
                    "keep this window open, then click Start browser bot."
                )
                self._emit()
                return {"ok": True, "already": False}
            time.sleep(0.25)

        return {
            "ok": False,
            "error": "Chrome started but debugging port did not open. Close all Chrome windows and try again.",
        }

    def open_login_chrome(self) -> dict[str, Any]:
        if self._running:
            return {
                "ok": False,
                "error": "Stop the bot first, then open Chrome to log in.",
            }
        return self.ensure_real_chrome()

    def start(self) -> None:
        if self._running:
            return
        # Do NOT kill Chrome — attach to the same real window
        self.engine.config.start_balance = 0.0
        self.config["start_balance"] = 0.0
        self.engine.state.message = "Starting…"
        self.live_multiplier = None
        self.awaiting_login = False
        self.betting_enabled = False
        self._login_ready.clear()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_thread, daemon=True)
        self._thread.start()

    def start_betting(self) -> dict[str, Any]:
        if not self._running:
            return {"ok": False, "error": "Start browser bot first."}
        self.betting_enabled = True
        self.site_message = "Betting ON — will place bets on next rounds"
        self._emit()
        return {"ok": True}

    def stop_betting(self) -> dict[str, Any]:
        self.betting_enabled = False
        self.site_message = "Betting OFF — browser still connected, watching only"
        self._emit()
        return {"ok": True}

    def request_balance_refresh(self) -> None:
        """After strategy reset: re-read wallet when browser is connected."""
        self._refresh_balance = True

    def confirm_login(self) -> None:
        self._login_ready.set()
        self.site_message = "Login confirmed — reading balance…"
        self._emit()

    def stop(self) -> None:
        self._stop.set()
        self._login_ready.set()
        self._running = False
        self.awaiting_login = False
        self.betting_enabled = False
        self.site_message = "Stopping bot (Chrome stays open)…"
        self._emit()

    def _run_thread(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        from playwright.async_api import async_playwright

        self._running = True
        self.site_message = "Connecting to real Chrome…"
        self._emit()

        browser = None
        try:
            # Ensure real Chrome is up, then attach (no Playwright-launched browser)
            ensured = self.ensure_real_chrome()
            if not ensured.get("ok"):
                self.site_message = ensured.get("error", "Could not start Chrome")
                self._emit()
                return

            async with async_playwright() as p:
                self.site_message = "Attaching to real Chrome (CDP)…"
                self._emit()
                browser = await p.chromium.connect_over_cdp(CDP_URL)
                self._browser = browser

                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                self._context = context

                page = None
                url = self.config.get("site_url", "https://bc.game/game/crash")
                for pge in context.pages:
                    try:
                        if "crash" in (pge.url or "").lower() or "bc" in (pge.url or "").lower():
                            page = pge
                            break
                    except Exception:  # noqa: BLE001
                        continue
                if page is None:
                    page = context.pages[0] if context.pages else await context.new_page()
                self._page = page

                try:
                    await page.bring_to_front()
                except Exception:  # noqa: BLE001
                    pass

                # Navigate only if not already on a crash-like page
                try:
                    cur = page.url or ""
                except Exception:  # noqa: BLE001
                    cur = ""
                if "crash" not in cur.lower():
                    await page.goto(url, wait_until="domcontentloaded")
                    await asyncio.sleep(1.5)
                else:
                    await asyncio.sleep(0.8)

                balance_captured = False
                bal = await self._read_balance(page)
                if bal is not None and bal >= 0:
                    self.engine.set_start_balance(bal)
                    self.config["start_balance"] = bal
                    balance_captured = True
                    self.site_message = f"Connected. Start balance: {bal}"
                    self._emit()

                if not balance_captured:
                    self.awaiting_login = True
                    self.site_message = (
                        "Log in in the open Chrome window (OTP works). "
                        "When done, click “I’m logged in — continue”. Keep Chrome open."
                    )
                    self._emit()
                    while not self._stop.is_set() and not self._login_ready.is_set():
                        await asyncio.sleep(0.4)
                    self.awaiting_login = False
                    if self._stop.is_set():
                        return
                    await asyncio.sleep(1.0)
                    for _ in range(30):
                        if self._stop.is_set():
                            return
                        if await self._login_modal_open(page):
                            self.awaiting_login = True
                            self._login_ready.clear()
                            self.site_message = (
                                "Sign-in still open — finish login, then Continue."
                            )
                            self._emit()
                            while not self._stop.is_set() and not self._login_ready.is_set():
                                await asyncio.sleep(0.4)
                            self.awaiting_login = False
                            await asyncio.sleep(1.0)
                            continue
                        bal = await self._read_balance(page)
                        if bal is not None and bal >= 0:
                            self.engine.set_start_balance(bal)
                            self.config["start_balance"] = bal
                            balance_captured = True
                            self.site_message = f"Start balance from site: {bal}"
                            self._emit()
                            break
                        await asyncio.sleep(1)

                if self._stop.is_set():
                    return
                if not balance_captured:
                    # Last attempt with debug hint
                    bal = await self._read_balance(page)
                    tip = f" (saw {bal})" if bal is not None else ""
                    self.site_message = (
                        "Could not read wallet balance"
                        f"{tip}. Make sure Crash page shows $ balance next to Deposit, then Start again."
                    )
                    self._emit()
                    return

                self.betting_enabled = False
                self.site_message = (
                    "Browser connected — watching site. "
                    "Click Start bet under settings when ready."
                )
                self._emit()

                last_phase = "unknown"
                pending_bet: dict[str, float] | None = None

                while not self._stop.is_set():
                    if self._refresh_balance:
                        self._refresh_balance = False
                        bal = await self._read_balance(page)
                        if bal is not None and bal >= 0:
                            self.engine.set_start_balance(bal)
                            self.config["start_balance"] = bal
                            self.site_message = f"Reset done. Start balance from site: {bal}"
                        else:
                            self.site_message = (
                                "Reset done. Start/current cleared (could not re-read wallet)."
                            )
                        self._emit()

                    if await self._login_modal_open(page):
                        pending_bet = None
                        self.betting_enabled = False
                        self.awaiting_login = True
                        self._login_ready.clear()
                        self.site_message = (
                            "Sign-in appeared — finish login in Chrome, then Continue."
                        )
                        self._emit()
                        while not self._stop.is_set() and not self._login_ready.is_set():
                            await asyncio.sleep(0.4)
                        self.awaiting_login = False
                        await asyncio.sleep(1.0)
                        continue

                    if self.engine.state.mode == Mode.STOPPED:
                        self.betting_enabled = False
                        self.site_message = self.engine.state.message
                        self._emit()
                        await asyncio.sleep(1)
                        continue

                    mult = await self._read_multiplier(page)
                    if mult is not None:
                        self.live_multiplier = mult
                        self.engine.state.last_multiplier_seen = mult

                    phase = await self._detect_phase(page, mult)

                    if phase == "betting" and last_phase != "betting":
                        if not self.betting_enabled:
                            pending_bet = None
                            self.site_message = (
                                "Watching rounds (betting OFF). Click Start bet to play."
                            )
                        elif self.engine.state.mode == Mode.RESTING:
                            # Count this round as rest (no bet)
                            self.engine.on_round_skipped()
                            self.site_message = self.engine.state.message
                            pending_bet = None
                            # Rest finished on this tick → place first recovery on NEXT round
                            # (message already says Recovery ready)
                        elif self.engine.state.mode == Mode.RECOVERY:
                            pending_bet = self.engine.next_bet()
                            if pending_bet:
                                bal = await self._read_balance(page)
                                stake = pending_bet["stake"]
                                if bal is not None and stake > bal + 1e-9:
                                    # Stop betting only — keep browser connected
                                    self.engine.state.message = (
                                        f"Recovery blocked: need {stake}, balance {bal}. "
                                        f"Betting stopped — deposit or lower B, then Start bet."
                                    )
                                    self.site_message = self.engine.state.message
                                    self.betting_enabled = False
                                    pending_bet = None
                                    self._emit()
                                else:
                                    ok = await self._place_bet(
                                        page, stake, pending_bet["cashout"]
                                    )
                                    if ok:
                                        self.site_message = (
                                            f"RECOVERY bet {stake} "
                                            f"@ {pending_bet['cashout']}x "
                                            f"({self.engine.state.recovery_left} left)"
                                        )
                                    else:
                                        self.site_message = (
                                            "Recovery bet fill failed — will retry next round"
                                        )
                                        pending_bet = None
                            else:
                                self.site_message = self.engine.state.message
                                pending_bet = None
                        else:
                            pending_bet = self.engine.next_bet()
                            if pending_bet:
                                bal = await self._read_balance(page)
                                if bal is not None and pending_bet["stake"] > bal + 1e-9:
                                    self.site_message = (
                                        f"Skip bet: stake {pending_bet['stake']} > balance {bal}"
                                    )
                                    pending_bet = None
                                else:
                                    ok = await self._place_bet(
                                        page,
                                        pending_bet["stake"],
                                        pending_bet["cashout"],
                                    )
                                    if ok:
                                        self.site_message = (
                                            f"Placed bet {pending_bet['stake']} "
                                            f"@ {pending_bet['cashout']}x"
                                        )
                                    else:
                                        self.site_message = (
                                            "Could not fill/click bet — check selectors / UI"
                                        )
                                        pending_bet = None
                            else:
                                self.site_message = self.engine.state.message
                                pending_bet = None

                    if phase == "crashed" and last_phase not in ("crashed", "unknown"):
                        if pending_bet is not None:
                            cashout = pending_bet["cashout"]
                            # Real crash from history strip — NOT cashout (1.45) marker
                            await asyncio.sleep(0.45)
                            crash_at = await self._read_latest_history_crash(page)
                            if crash_at is None:
                                crash_at = await self._read_crashed_at_text(page)
                            if crash_at is None and mult and mult > cashout + 0.05:
                                # live mult only if clearly above cashout (avoid 1.45 UI ghost)
                                crash_at = mult
                            won = (
                                crash_at is not None and crash_at + 1e-9 >= cashout
                            )
                            self.engine.on_bet_result(
                                won=won,
                                stake=pending_bet["stake"],
                                crash_at=crash_at,
                            )
                            self.site_message = (
                                f"{'Win' if won else 'Lose'} @ crash "
                                f"{crash_at if crash_at is not None else '?'}x "
                                f"(cashout {cashout}x) | {self.engine.state.message}"
                            )
                            pending_bet = None

                    last_phase = phase
                    self._emit()
                    await asyncio.sleep(0.35)

        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if "has been closed" in msg or "Target closed" in msg or "Target page" in msg:
                self.site_message = "Chrome closed or disconnected"
            else:
                self.site_message = f"Bot error: {exc}"
            self._emit()
        finally:
            # Disconnect only — do NOT close real Chrome
            self._running = False
            self._page = None
            self._context = None
            self._browser = None
            if "Bot error" not in self.site_message and "Could not" not in self.site_message:
                if "Chrome closed" not in self.site_message:
                    self.site_message = "Bot stopped — Chrome left open (session kept)"
            self._emit()

    async def _first_locator(self, page, keys: list[str]):
        for sel in keys:
            loc = page.locator(sel).first
            try:
                if await loc.count() > 0 and await loc.is_visible():
                    return loc
            except Exception:  # noqa: BLE001
                continue
        return None

    async def _login_modal_open(self, page) -> bool:
        try:
            dialog = page.locator("[role='dialog'], [class*='modal']").filter(
                has_text=re.compile(r"Sign In|Sign Up|One-time Code|Forgot your password", re.I)
            )
            n = await dialog.count()
            for i in range(min(n, 5)):
                node = dialog.nth(i)
                if await node.is_visible():
                    return True
        except Exception:  # noqa: BLE001
            pass
        return False

    async def _place_bet(self, page, stake: float, cashout: float) -> bool:
        if await self._login_modal_open(page):
            self.site_message = "Skipped bet fill — sign-in is open"
            return False

        # Ensure Manual tab if present
        try:
            manual = page.get_by_role("tab", name=re.compile(r"^Manual$", re.I))
            if await manual.count() and await manual.first.is_visible():
                await manual.first.click()
                await asyncio.sleep(0.15)
        except Exception:  # noqa: BLE001
            pass

        amount_loc = await self._input_near_label(page, r"^Amount")
        if amount_loc is None:
            amount_loc = await self._first_locator(
                page, self.config.get("selectors", {}).get("bet_amount", [])
            )
        cash_loc = await self._input_near_label(page, r"Auto cash out")
        if cash_loc is None:
            cash_loc = await self._first_locator(
                page, self.config.get("selectors", {}).get("cashout", [])
            )

        # Only the main bet button — never 2x / 10 / quick chips
        btn_loc = None
        try:
            for pattern in (r"^Bet$", r"^Main Bet", r"Bet \(Next Round\)"):
                btn = page.get_by_role("button", name=re.compile(pattern, re.I))
                if await btn.count() and await btn.first.is_visible():
                    btn_loc = btn.first
                    break
        except Exception:  # noqa: BLE001
            pass
        if btn_loc is None:
            btn_loc = await self._first_locator(
                page, ["button:has-text('Main Bet')", "button:has-text('Bet')"]
            )

        if amount_loc is None or btn_loc is None:
            return False

        try:
            stake_txt = self._fmt(stake)
            cash_txt = self._fmt(cashout)

            await amount_loc.click()
            await amount_loc.fill("")
            await amount_loc.press("Control+A")
            await amount_loc.fill(stake_txt)
            await asyncio.sleep(0.1)

            # Verify amount — abort if site clamped to all-in / wrong value
            try:
                shown = await amount_loc.input_value()
                shown_val = float(re.sub(r"[^\d.]", "", shown) or "nan")
                if shown_val == shown_val:  # not NaN
                    if abs(shown_val - stake) > max(0.0001, stake * 0.05):
                        self.site_message = (
                            f"Amount mismatch: wanted {stake}, field shows {shown_val} — aborted"
                        )
                        return False
            except Exception:  # noqa: BLE001
                pass

            if cash_loc is not None:
                await cash_loc.click()
                await cash_loc.fill("")
                await cash_loc.press("Control+A")
                await cash_loc.fill(cash_txt)

            await btn_loc.click()
            return True
        except Exception as exc:  # noqa: BLE001
            self.site_message = f"Fill error: {exc}"
            return False

    async def _input_near_label(self, page, label_re: str):
        try:
            label = page.get_by_text(re.compile(label_re, re.I)).first
            if await label.count() == 0:
                return None
            root = label.locator("xpath=ancestor::*[.//input][1]")
            inp = root.locator("input").first
            if await inp.count() and await inp.is_visible():
                return inp
        except Exception:  # noqa: BLE001
            return None
        return None

    async def _read_latest_history_crash(self, page) -> float | None:
        """Read newest crash from the top history chips (e.g. 40.94x), not cashout 1.45."""
        try:
            val = await page.evaluate(
                """() => {
                  const chips = [];
                  for (const el of document.querySelectorAll('div, span, a, button')) {
                    if (el.offsetParent === null) continue;
                    const t = (el.innerText || '').trim();
                    if (!/^\\d+(\\.\\d+)?x$/i.test(t)) continue;
                    if (t.length > 12) continue;
                    const r = el.getBoundingClientRect();
                    // History strip is near the top of the game panel
                    if (r.top < 40 || r.top > 280 || r.width < 8) continue;
                    const v = parseFloat(t);
                    if (v >= 1) chips.push({ v, left: r.left, top: r.top });
                  }
                  if (!chips.length) return null;
                  // Prefer the top-most row; newest is usually left-most on BC.Game
                  chips.sort((a, b) => a.top - b.top || a.left - b.left);
                  const topY = chips[0].top;
                  const row = chips.filter((c) => Math.abs(c.top - topY) < 20);
                  row.sort((a, b) => a.left - b.left);
                  return row[0].v;
                }"""
            )
            if isinstance(val, (int, float)) and val >= 1:
                return float(val)
        except Exception:  # noqa: BLE001
            pass
        return None

    async def _read_crashed_at_text(self, page) -> float | None:
        try:
            text = await page.locator("body").inner_text()
            m = re.search(
                r"(?:crashed|bust)[^\d]{0,12}(\d+\.?\d*)\s*x",
                text,
                flags=re.I,
            )
            if m:
                return float(m.group(1))
            # Big center crash number sometimes shown alone
            m2 = re.search(r"\b(\d+\.\d{2})\s*x\b", text)
            if m2:
                v = float(m2.group(1))
                # Ignore the cashout setting if that's all we found
                return v
        except Exception:  # noqa: BLE001
            pass
        return None

    @staticmethod
    def _fmt(value: float) -> str:
        text = f"{value:.8f}".rstrip("0").rstrip(".")
        return text if text else "0"

    async def _read_balance(self, page) -> float | None:
        """Read header wallet (e.g. $0.01 next to Deposit on BC.Game)."""
        try:
            val = await page.evaluate(
                """() => {
                  const fromDollar = (t) => {
                    if (!t) return null;
                    const m = String(t).replace(/,/g, '').match(/\\$\\s*([\\d]+(?:\\.\\d+)?)/);
                    return m ? parseFloat(m[1]) : null;
                  };

                  const all = Array.from(document.querySelectorAll('button, a, div, span'));
                  const deposit = all.find((el) => {
                    const t = (el.innerText || '').trim();
                    return /^Deposit$/i.test(t) && el.offsetParent !== null;
                  });

                  if (deposit) {
                    let root = deposit.parentElement;
                    for (let depth = 0; depth < 6 && root; depth++) {
                      const nodes = Array.from(root.querySelectorAll('div, span, p, b, strong'));
                      for (const el of nodes) {
                        if (el.closest('[role="dialog"]')) continue;
                        const t = (el.innerText || '').trim();
                        if (!t || t.length > 24) continue;
                        if (!t.includes('$')) continue;
                        if (/deposit/i.test(t)) continue;
                        const v = fromDollar(t);
                        if (v != null && v >= 0) return v;
                      }
                      root = root.parentElement;
                    }
                  }

                  const header =
                    document.querySelector('header') ||
                    document.querySelector('[class*="Header"]') ||
                    document.querySelector('nav');
                  if (header) {
                    const ms = [...(header.innerText || '').matchAll(/\\$\\s*([\\d,]+(?:\\.\\d+)?)/g)]
                      .map((m) => parseFloat(m[1].replace(/,/g, '')))
                      .filter((n) => !Number.isNaN(n) && n >= 0 && n < 1000000);
                    if (ms.length) return Math.min(...ms);
                  }
                  return null;
                }"""
            )
            if isinstance(val, (int, float)) and val >= 0:
                return float(val)
        except Exception as exc:  # noqa: BLE001
            self.site_message = f"Balance scan error: {exc}"

        selectors = self.config.get("selectors", {}).get("balance", [])
        for sel in selectors:
            loc = page.locator(sel)
            try:
                n = await loc.count()
            except Exception:  # noqa: BLE001
                continue
            for i in range(min(n, 8)):
                try:
                    node = loc.nth(i)
                    if not await node.is_visible():
                        continue
                    text = (await node.inner_text()).strip()
                    if not text or len(text) > 30:
                        continue
                    if re.search(r"\d+\.\d+\s*x", text, re.I):
                        continue
                    parsed = self._parse_money(text)
                    if parsed is not None and parsed >= 0:
                        return parsed
                except Exception:  # noqa: BLE001
                    continue
        return None

    @staticmethod
    def _parse_money(text: str) -> float | None:
        if not text:
            return None
        if re.search(r"\d+\.\d+\s*x\b", text, re.I):
            return None
        m = re.search(r"\$\s*([\d,]+(?:\.\d+)?)", text)
        if m:
            try:
                return float(m.group(1).replace(",", ""))
            except ValueError:
                return None
        cleaned = text.replace(",", "").replace("\u00a0", " ").strip()
        m2 = re.search(r"(\d+(?:\.\d+)?)", cleaned)
        if not m2:
            return None
        try:
            return float(m2.group(1))
        except ValueError:
            return None

    async def _read_multiplier(self, page) -> float | None:
        """Live flying multiplier only — ignore cashout field (1.45) and history chips."""
        try:
            val = await page.evaluate(
                """() => {
                  const nodes = Array.from(document.querySelectorAll('div, span'));
                  let best = null;
                  for (const el of nodes) {
                    if (el.offsetParent === null) continue;
                    const t = (el.innerText || '').trim();
                    if (!/^\\d+\\.\\d{2}x$/i.test(t)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 40 || r.height < 20) continue;
                    if (r.top < 120) continue;
                    const v = parseFloat(t);
                    if (v < 1) continue;
                    const area = r.width * r.height;
                    if (!best || area > best.area) best = { v, area };
                  }
                  return best ? best.v : null;
                }"""
            )
            if isinstance(val, (int, float)) and val >= 1:
                return float(val)
        except Exception:  # noqa: BLE001
            pass
        return None

    async def _detect_phase(self, page, mult: float | None) -> str:
        try:
            text = (await page.locator("body").inner_text()).lower()
        except Exception:  # noqa: BLE001
            text = ""

        if "crashed" in text or "bust" in text:
            return "crashed"
        if any(k in text for k in ("place your bet", "betting", "waiting for next", "starts in")):
            return "betting"
        if mult is not None and mult > 1.01:
            return "flying"
        if "bet" in text:
            return "betting"
        return "unknown"

    async def _result_hint(self, page) -> bool | None:
        try:
            text = (await page.locator("body").inner_text()).lower()
        except Exception:  # noqa: BLE001
            return None
        if "you won" in text or "cashed out" in text:
            return True
        if "you lost" in text:
            return False
        return None
