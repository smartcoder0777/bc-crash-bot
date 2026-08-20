"""Control BC Crash via real Chrome (CDP). Never launches Playwright's automated browser."""

from __future__ import annotations

import asyncio
import re
import subprocess
import sys
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
        self._kick_bet = False
        self.live_multiplier: float | None = None
        self.site_message = "Browser not started"
        self._last_log = ""
        self._last_log_ts = 0.0

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

    def _log(self, msg: str, *, repeat_s: float = 0.0) -> None:
        """Print to the dashboard terminal. repeat_s>0 throttles identical lines."""
        now = time.time()
        if repeat_s > 0 and msg == self._last_log and now - self._last_log_ts < repeat_s:
            return
        self._last_log = msg
        self._last_log_ts = now
        print(f"[bot {time.strftime('%H:%M:%S')}] {msg}", flush=True)
        sys.stdout.flush()

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
        self._kick_bet = False
        self._login_ready.clear()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_thread, daemon=True)
        self._thread.start()

    def start_betting(self) -> dict[str, Any]:
        if not self._running:
            return {"ok": False, "error": "Start browser bot first."}
        self.betting_enabled = True
        self._kick_bet = True
        self.site_message = "Betting ON — will place bets on next rounds"
        self._log(self.site_message)
        self._emit()
        return {"ok": True}

    def stop_betting(self) -> dict[str, Any]:
        self.betting_enabled = False
        self.site_message = "Betting OFF — browser still connected, watching only"
        self._log(self.site_message)
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
        self._log(self.site_message)
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
                pending_bet: dict[str, Any] | None = None
                last_logged_phase = ""
                self._log("Watching Crash page — click Start bet when ready")

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
                        self._log(self.site_message)
                        self._emit()

                    if await self._login_modal_open(page):
                        pending_bet = None
                        self.betting_enabled = False
                        self.awaiting_login = True
                        self._login_ready.clear()
                        self.site_message = (
                            "Sign-in appeared — finish login in Chrome, then Continue."
                        )
                        self._log(self.site_message)
                        self._emit()
                        while not self._stop.is_set() and not self._login_ready.is_set():
                            await asyncio.sleep(0.4)
                        self.awaiting_login = False
                        await asyncio.sleep(1.0)
                        continue

                    if self.engine.state.mode == Mode.STOPPED:
                        self.betting_enabled = False
                        self.site_message = self.engine.state.message
                        self._log(self.site_message, repeat_s=5)
                        self._emit()
                        await asyncio.sleep(1)
                        continue

                    cashout_cfg = float(self.engine.config.cashout)
                    raw_mult = await self._read_multiplier(page)
                    # Ignore cashout-field ghosts (1.45) when not actually flying
                    if raw_mult is not None and abs(float(raw_mult) - cashout_cfg) < 0.021:
                        if pending_bet is None or float(pending_bet.get("peak_mult") or 0) < cashout_cfg - 0.05:
                            raw_mult = None
                    if raw_mult is not None:
                        self.live_multiplier = raw_mult
                        self.engine.state.last_multiplier_seen = raw_mult
                    elif pending_bet is None:
                        self.live_multiplier = None

                    phase = await self._detect_phase(page, self.live_multiplier)
                    if phase != last_logged_phase:
                        self._log(
                            f"phase {last_phase} → {phase}  live={self.live_multiplier}  "
                            f"bet_on={self.betting_enabled}  pending={pending_bet is not None}"
                        )
                        last_logged_phase = phase

                    # Settle previous bet from DOM before opening another
                    if pending_bet is not None:
                        if self.live_multiplier is not None:
                            mult = float(self.live_multiplier)
                            peak = float(pending_bet.get("peak_mult") or 0.0)
                            cashout_ghost = (
                                abs(mult - cashout_cfg) < 0.021
                                and peak + 1e-9 < cashout_cfg - 0.05
                            )
                            if mult > peak + 1e-9 and not cashout_ghost:
                                pending_bet["peak_mult"] = mult
                                pending_bet["peak_ts"] = time.time()
                            if mult > 1.001 and mult + 1e-9 < cashout_cfg - 0.01:
                                prev = float(pending_bet.get("max_below_cashout") or 0.0)
                                if mult > prev:
                                    pending_bet["max_below_cashout"] = mult
                            if mult > 1.001 and not cashout_ghost:
                                pending_bet["saw_flying"] = True
                        if phase == "flying":
                            pending_bet["saw_flying"] = True
                        settled = await self._settle_pending(page, pending_bet, phase)
                        age = time.time() - float(pending_bet.get("placed_ts") or 0)
                        if settled:
                            self._log(self.site_message)
                            pending_bet = None
                            if phase == "betting":
                                last_phase = "settled"
                            else:
                                last_phase = phase
                        else:
                            self._log(
                                f"waiting settle {age:.1f}s phase={phase} "
                                f"live={self.live_multiplier} peak={pending_bet.get('peak_mult')} "
                                f"saw_fly={pending_bet.get('saw_flying')}",
                                repeat_s=1.5,
                            )
                            if phase != "betting":
                                last_phase = phase
                        self._emit()
                        await asyncio.sleep(0.2)
                        continue

                    if self._kick_bet and self.betting_enabled:
                        self._kick_bet = False
                        last_phase = "kicked"
                        self._log("Start bet clicked — will place on this/next betting window")

                    if phase == "betting" and last_phase != "betting":
                        if not self.betting_enabled:
                            self.site_message = (
                                "Watching rounds (betting OFF). Click Start bet to play."
                            )
                            self._log("betting window — betting OFF, skip", repeat_s=8)
                        elif self.engine.state.mode == Mode.RESTING:
                            self.engine.on_round_skipped()
                            self.site_message = self.engine.state.message
                            self._log(self.site_message)
                        else:
                            nxt = self.engine.next_bet()
                            if nxt:
                                bal = await self._read_balance(page)
                                stake = nxt["stake"]
                                self._log(
                                    f"betting window — try stake={stake} cashout={nxt['cashout']} "
                                    f"bal={bal} mode={self.engine.state.mode.value}"
                                )
                                if (
                                    self.engine.state.mode == Mode.RECOVERY
                                    and bal is not None
                                    and stake > bal + 1e-9
                                ):
                                    self.engine.state.message = (
                                        f"Recovery blocked: need {stake}, balance {bal}. "
                                        f"Betting stopped — deposit or lower B, then Start bet."
                                    )
                                    self.site_message = self.engine.state.message
                                    self.betting_enabled = False
                                    self._log(self.site_message)
                                    self._emit()
                                elif bal is not None and stake > bal + 1e-9:
                                    self.site_message = (
                                        f"Skip bet: stake {stake} > balance {bal}"
                                    )
                                    self._log(self.site_message)
                                else:
                                    hist = await self._read_latest_history_crash(page)
                                    ok = await self._place_bet(
                                        page, stake, nxt["cashout"]
                                    )
                                    if ok:
                                        pending_bet = {
                                            **nxt,
                                            "placed_ts": time.time(),
                                            "hist_at_place": hist,
                                            "bal_at_place": bal,
                                            "peak_mult": 1.0,
                                            "peak_ts": time.time(),
                                            "saw_flying": False,
                                            "max_below_cashout": 0.0,
                                        }
                                        tag = (
                                            "RECOVERY"
                                            if self.engine.state.mode == Mode.RECOVERY
                                            else "Bet"
                                        )
                                        self.site_message = (
                                            f"{tag} {stake} @ {nxt['cashout']}x placed"
                                        )
                                        self._log(
                                            f"{self.site_message} (hist_at_place={hist})"
                                        )
                                    else:
                                        self.site_message = (
                                            "Could not fill/click bet — will retry next round"
                                        )
                                        self._log(self.site_message)
                            else:
                                self.site_message = self.engine.state.message
                                self._log(f"next_bet empty: {self.site_message}")

                    last_phase = phase
                    self._emit()
                    await asyncio.sleep(0.3)

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

    async def _settle_pending(
        self, page, pending_bet: dict[str, Any], phase: str | None = None
    ) -> bool:
        """Settle win/lose from peak live mult + history (handles instant 1.0x busts)."""
        cashout = float(pending_bet["cashout"])
        stake = float(pending_bet["stake"])
        placed_ts = float(pending_bet.get("placed_ts") or 0)
        hist_at_place = pending_bet.get("hist_at_place")
        bal_at_place = pending_bet.get("bal_at_place")
        peak = float(pending_bet.get("peak_mult") or 0.0)
        peak_ts = float(pending_bet.get("peak_ts") or placed_ts)
        saw_flying = bool(pending_bet.get("saw_flying"))
        age = time.time() - placed_ts
        live = self.live_multiplier
        peak_frozen = (time.time() - peak_ts) >= 0.65

        if phase is None:
            phase = await self._detect_phase(page, live)

        # Mid-flight only when clearly climbing. Stuck 1.02x is NOT flying.
        still_flying = live is not None and live > 1.12
        if still_flying and age < 25:
            self._log(f"settle wait: still flying live={live}", repeat_s=2)
            return False

        # Countdown after placing — round has not started yet
        if not saw_flying and phase == "betting" and age < 8.0:
            self._log(f"settle wait: countdown (round not started) {age:.1f}s", repeat_s=2)
            return False

        if age < 0.6:
            return False

        hist = await self._read_latest_history_crash(page)
        # Ignore cashout setting masquerading as a history chip
        if hist is not None and abs(float(hist) - cashout) < 0.021:
            # Only keep it if we truly climbed past cashout
            if peak + 1e-9 < cashout:
                hist = None

        hist_changed = (
            hist is not None
            and hist_at_place is not None
            and abs(float(hist) - float(hist_at_place)) > 1e-9
        )

        won: bool | None = None
        crash_at: float | None = None
        source = ""

        # 1) History below cashout ALWAYS loses — beats peak/cashout ghosts
        if hist_changed and hist is not None and float(hist) + 1e-9 < cashout:
            won = False
            crash_at = float(hist)
            source = f"history-lose {crash_at}x"

        # 2) History above cashout → win
        elif hist_changed and hist is not None and float(hist) + 1e-9 >= cashout:
            won = True
            crash_at = float(hist)
            source = f"history-win {crash_at}x"

        # 3) Peak truly reached cashout (must have climbed toward it — not a lone 1.45 ghost)
        elif peak + 1e-9 >= cashout and (
            peak > cashout + 0.03
            or float(pending_bet.get("max_below_cashout") or 0) >= cashout - 0.15
        ):
            won = True
            crash_at = hist if hist_changed else peak
            source = f"peak {peak:.2f}x"

        # 4) Low bust (1.00–just under cashout): peak froze below cashout
        elif (
            saw_flying
            and peak + 1e-9 < cashout
            and peak_frozen
            and (phase in ("crashed", "betting", "unknown") or age >= 1.2)
        ):
            won = False
            crash_at = float(hist) if hist is not None else peak
            source = f"fast-bust {crash_at}x"

        # 5) Flight done, never reached cashout, next betting window
        elif (
            saw_flying
            and peak + 1e-9 < cashout
            and phase == "betting"
            and age >= 2.0
        ):
            won = False
            crash_at = float(hist) if hist is not None else (peak if peak >= 1.0 else None)
            source = f"bust-after-flight {crash_at if crash_at is not None else peak:.2f}x"

        # 6) Wallet delta backup
        if won is None and bal_at_place is not None and age >= 2.0:
            bal = await self._read_balance(page)
            if bal is not None:
                delta = float(bal) - float(bal_at_place)
                profit_min = stake * (cashout - 1.0) * 0.4
                if delta >= profit_min:
                    won = True
                    crash_at = hist if hist_changed else peak or None
                    source = f"balance +{delta:.4f}"
                elif delta <= -stake * 0.5:
                    won = False
                    crash_at = hist if hist is not None else None
                    source = f"balance {delta:.4f}"

        if won is None:
            if age >= 12.0:
                # Prefer lose when peak never clearly beat cashout
                if peak + 1e-9 >= cashout and peak > cashout + 0.02:
                    won = True
                    crash_at = peak
                    source = "timeout-peak-win"
                else:
                    won = False
                    crash_at = hist if hist is not None else (peak if peak >= 1.0 else None)
                    source = "timeout-lose"
            else:
                self._log(
                    f"settle wait: no result yet age={age:.1f}s phase={phase} "
                    f"peak={peak} hist={hist} hist_chg={hist_changed} fly={saw_flying}",
                    repeat_s=2,
                )
                return False

        self.engine.on_bet_result(won=won, stake=stake, crash_at=crash_at)
        nxt = self.engine.next_bet()
        nxt_txt = (
            f"next {nxt['stake']}"
            if nxt and self.engine.state.mode != Mode.RESTING
            else self.engine.state.message
        )
        self.site_message = f"{'Win' if won else 'Lose'} ({source}) | {nxt_txt}"
        return True

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
            self._log(f"place_bet fail: amount={amount_loc is not None} btn={btn_loc is not None}")
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
                        self._log(self.site_message)
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
                v = float(m.group(1))
                # Ignore values that are just our cashout setting
                cashout = float(self.engine.config.cashout)
                if abs(v - cashout) < 0.021:
                    return None
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
        cashout = float(self.engine.config.cashout)
        try:
            val = await page.evaluate(
                """(cashout) => {
                  const nodes = Array.from(document.querySelectorAll('div, span'));
                  let best = null;
                  for (const el of nodes) {
                    if (el.offsetParent === null) continue;
                    if (el.closest('input,label,form,textarea')) continue;
                    const t = (el.innerText || '').trim();
                    if (!/^\\d+\\.\\d{2}x$/i.test(t)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 48 || r.height < 28) continue;
                    if (r.top < 120) continue;
                    if (r.left > window.innerWidth * 0.72) continue;
                    const v = parseFloat(t);
                    if (v < 1) continue;
                    const area = r.width * r.height;
                    // Cashout setting is a small-ish label; live crash number is huge
                    if (Math.abs(v - cashout) < 0.021 && area < 14000) continue;
                    if (!best || area > best.area) best = { v, area };
                  }
                  return best ? best.v : null;
                }""",
                cashout,
            )
            if isinstance(val, (int, float)) and val >= 1:
                return float(val)
        except Exception:  # noqa: BLE001
            pass
        return None

    async def _detect_phase(self, page, mult: float | None) -> str:
        """Detect round phase from UI. Prefer countdown / live mult over rare words."""
        try:
            hint = await page.evaluate(
                """() => {
                  const t = (document.body && document.body.innerText || '').toLowerCase();
                  if (/starts?\\s*in/.test(t) || t.includes('place your bet')
                      || t.includes('waiting for next') || t.includes('next round')) {
                    return 'betting';
                  }
                  if (/\\bcrashed\\b|\\bbusted\\b/.test(t) && !/starts?\\s*in/.test(t)) {
                    return 'crashed';
                  }
                  return '';
                }"""
            )
        except Exception:  # noqa: BLE001
            hint = ""

        if hint == "betting":
            return "betting"
        if mult is not None and mult > 1.12:
            return "flying"
        if hint == "crashed":
            return "crashed"
        if mult is None or mult <= 1.12:
            # Bet button is always on the page — only call it betting if no live climb
            try:
                btn = page.get_by_role("button", name=re.compile(r"^Bet$|^Main Bet|Bet \(Next Round\)", re.I))
                if await btn.count() and await btn.first.is_visible():
                    return "betting"
            except Exception:  # noqa: BLE001
                pass
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
