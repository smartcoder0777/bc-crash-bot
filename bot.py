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
        line = f"[bot {time.strftime('%H:%M:%S')}] {msg}"
        try:
            print(line, flush=True)
        except UnicodeEncodeError:
            enc = getattr(sys.stdout, "encoding", None) or "utf-8"
            sys.stdout.buffer.write((line + "\n").encode(enc, errors="replace"))
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
                    if raw_mult is not None:
                        self.live_multiplier = raw_mult
                        self.engine.state.last_multiplier_seen = raw_mult
                    elif pending_bet is None:
                        self.live_multiplier = None

                    phase = await self._detect_phase(page, self.live_multiplier)
                    if phase != last_logged_phase:
                        self._log(
                            f"phase {last_phase} -> {phase}  live={self.live_multiplier}  "
                            f"bet_on={self.betting_enabled}  pending={pending_bet is not None}"
                        )
                        last_logged_phase = phase

                    # Settle previous bet from DOM before opening another
                    if pending_bet is not None:
                        if self.live_multiplier is not None:
                            mult = float(self.live_multiplier)
                            peak = float(pending_bet.get("peak_mult") or 0.0)
                            if mult > peak + 1e-9:
                                pending_bet["peak_mult"] = mult
                                pending_bet["peak_ts"] = time.time()
                            if mult > 1.001:
                                pending_bet["saw_flying"] = True
                                pending_bet["saw_round"] = True
                        if phase == "flying":
                            pending_bet["saw_flying"] = True
                            pending_bet["saw_round"] = True
                        # Instant 1.00–1.10 busts often skip a readable fly.
                        # Leaving the countdown (crashed/unknown) means our round ran.
                        if phase in ("flying", "crashed", "unknown"):
                            pending_bet["saw_round"] = True
                        if phase == "betting" and pending_bet.get("saw_round"):
                            pending_bet.setdefault("back_to_bet_ts", time.time())
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
                                    hist_row = await self._read_history_row(page)
                                    ok = await self._place_bet(
                                        page, stake, nxt["cashout"]
                                    )
                                    if ok:
                                        pending_bet = {
                                            **nxt,
                                            "placed_ts": time.time(),
                                            "hist_row": list(hist_row or []),
                                            "hist_max_id": max(
                                                (int(x.get("id") or 0) for x in (hist_row or [])),
                                                default=0,
                                            ),
                                            "bal_at_place": bal,
                                            "peak_mult": 1.0,
                                            "peak_ts": time.time(),
                                            "saw_flying": False,
                                            "saw_round": False,
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
                                            f"{self.site_message} (hist_row="
                                            f"{[x.get('v') if isinstance(x, dict) else x for x in (hist_row or [])][-5:]})"
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

    @staticmethod
    def _hist_max_id(row: list | None) -> int:
        return max(
            (int(x.get("id") or 0) for x in (row or []) if isinstance(x, dict)),
            default=0,
        )

    def _absorb_hist_baseline(
        self, pending_bet: dict[str, Any], hist_row: list, reason: str
    ) -> None:
        """Treat current chips as already-seen so they cannot settle this bet."""
        if not hist_row:
            return
        old = int(pending_bet.get("hist_max_id") or 0)
        new_id = self._hist_max_id(hist_row)
        pending_bet["hist_row"] = list(hist_row)
        pending_bet["hist_max_id"] = new_id
        if new_id != old:
            vals = [round(float(x.get("v") or 0), 2) for x in hist_row[-4:]]
            self._log(f"hist absorb ({reason}) max_id {old}->{new_id} v={vals}", repeat_s=2)

    @staticmethod
    def _new_crash_from_rows(
        before: list | None, after: list | None
    ) -> float | None:
        """Newest crash = highest round id that was not present when we placed."""
        if not after:
            return None

        def _items(row: list) -> list[dict[str, float]]:
            out: list[dict[str, float]] = []
            for x in row or []:
                if isinstance(x, dict) and "v" in x:
                    out.append({"id": float(x.get("id") or 0), "v": float(x["v"])})
                elif isinstance(x, (int, float)):
                    out.append({"id": 0.0, "v": float(x)})
            return out

        b = _items(before or [])
        a = _items(after)
        if not a or not b:
            return None
        b_ids = {int(x["id"]) for x in b if x["id"]}
        if b_ids:
            newer = [x for x in a if int(x["id"]) not in b_ids]
            if newer:
                newest = max(newer, key=lambda x: x["id"])
                return float(newest["v"])
            return None
        # Fallback: values only
        bv = [round(x["v"], 2) for x in b]
        av = [round(x["v"], 2) for x in a]
        if av == bv or not av:
            return None
        if av[-1] != (bv[-1] if bv else None):
            return float(a[-1]["v"])
        if av[0] != (bv[0] if bv else None):
            return float(a[0]["v"])
        return None

    async def _settle_pending(
        self, page, pending_bet: dict[str, Any], phase: str | None = None
    ) -> bool:
        """After our round: wallet up = win; still down on next countdown = lose."""
        cashout = float(pending_bet["cashout"])
        stake = float(pending_bet["stake"])
        placed_ts = float(pending_bet.get("placed_ts") or 0)
        hist_row_before = pending_bet.get("hist_row") or []
        bal_at_place = pending_bet.get("bal_at_place")
        peak = float(pending_bet.get("peak_mult") or 0.0)
        saw_round = bool(pending_bet.get("saw_round") or pending_bet.get("saw_flying"))
        age = time.time() - placed_ts
        live = self.live_multiplier

        if phase is None:
            phase = await self._detect_phase(page, live)

        hist_row = await self._read_history_row(page)
        # Parser was empty at click (max_id=0). First chips we see are already
        # on the bar — lock them as baseline, do not settle this tick as a win.
        if int(pending_bet.get("hist_max_id") or 0) <= 0 and hist_row:
            self._absorb_hist_baseline(pending_bet, hist_row, "first visible hist")
            hist_row_before = pending_bet.get("hist_row") or hist_row

        live_up = live is not None and float(live) > 1.12
        currently_flying = phase == "flying" or live_up
        # Same countdown we placed in — leftover chips are the previous round.
        # After we leave betting, a new chip is this bet (including instant 1.05).
        in_place_window = phase == "betting" and not saw_round

        max_id = int(pending_bet.get("hist_max_id") or 0)
        newer = [
            x
            for x in hist_row
            if isinstance(x, dict) and int(x.get("id") or 0) > max_id
        ]
        newest = max(newer, key=lambda x: int(x.get("id") or 0)) if newer else None
        new_crash = float(newest["v"]) if newest else None

        # Only ignore a chip while we are clearly still flying ABOVE it.
        # Instant 1.05: live is missing/low — that chip is ours, do not absorb.
        stale_chip = False
        if new_crash is not None:
            if in_place_window:
                stale_chip = True
            elif live_up and float(live) > float(new_crash) + 0.05:
                stale_chip = True

        if stale_chip:
            self._absorb_hist_baseline(
                pending_bet,
                hist_row,
                f"late chip {new_crash}x phase={phase} live={live}",
            )
            new_crash = None
            newest = None
        elif newest is not None:
            self._log(
                f"hist new id={int(newest['id'])} crash={new_crash} "
                f"(max_id={max_id})",
                repeat_s=2,
            )
        elif in_place_window:
            self._absorb_hist_baseline(pending_bet, hist_row, "pre-takeoff")
        elif hist_row_before:
            new_crash = self._new_crash_from_rows(hist_row_before, hist_row)

        still_flying = currently_flying
        if still_flying and new_crash is None and age < 40:
            self._log(f"settle wait: flying live={live} peak={peak:.2f}", repeat_s=3)
            return False

        if not saw_round and new_crash is None and age < 14.0:
            self._log(f"settle wait: round not started {age:.1f}s phase={phase}", repeat_s=3)
            return False

        if new_crash is not None and abs(float(new_crash) - cashout) < 0.021:
            if not hist_row or len(hist_row) <= 1:
                new_crash = None

        if age < 0.7 and new_crash is None:
            return False

        betting_window = phase == "betting"
        back_ts = pending_bet.get("back_to_bet_ts")
        since_next_bet = (time.time() - float(back_ts)) if back_ts else 0.0
        our_chip = new_crash is not None and not in_place_window

        won: bool | None = None
        crash_at: float | None = new_crash
        source = ""
        delta: float | None = None
        if bal_at_place is not None:
            bal = await self._read_balance(page)
            if bal is not None:
                delta = float(bal) - float(bal_at_place)
        profit = stake * (cashout - 1.0)

        # 1) Wallet payout = win (lags a few seconds into next countdown)
        if delta is not None and delta >= max(0.0001, profit * 0.25):
            won = True
            source = f"wallet +{delta:.4f}"

        # 2) Our round's chip < cashout = lose now (instant 1.05 included)
        if won is None and our_chip and float(new_crash) + 1e-9 < cashout:
            won = False
            crash_at = float(new_crash)
            source = f"history {crash_at}x"
            self._log(f"new crash chip {crash_at} (was {hist_row_before[:3]} now {hist_row[:3]})")

        # 3) High crash chip = win only after our round started
        if (
            won is None
            and our_chip
            and float(new_crash) + 1e-9 >= cashout
            and not (delta is not None and delta <= -stake * 0.35 and since_next_bet >= 6.5)
        ):
            won = True
            crash_at = float(new_crash)
            source = f"history {crash_at}x"
            self._log(f"new crash chip {crash_at} (was {hist_row_before[:3]} now {hist_row[:3]})")

        # 4) Peak reached cashout
        if won is None and peak + 1e-9 >= cashout and (betting_window or age >= 4.0):
            won = True
            crash_at = peak
            source = f"peak {peak:.2f}x"

        # 5) Wallet-only fallback if history chips were missed. Do not fire in
        #    the same countdown we placed in (stake debit looks like a lose).
        if (
            won is None
            and saw_round
            and betting_window
            and since_next_bet >= 6.5
            and delta is not None
            and delta <= -stake * 0.35
            and peak + 1e-9 < cashout
        ):
            won = False
            crash_at = new_crash
            source = f"wallet {delta:.4f} no payout"

        if won is None:
            wallet_quiet = delta is not None and abs(float(delta)) < stake * 0.1
            if saw_round and (
                age >= 40
                or (wallet_quiet and age >= 25 and since_next_bet >= 8)
            ):
                self.site_message = (
                    f"Settle timeout {age:.0f}s — dropped pending, no win/lose applied"
                )
                self._log(
                    f"{self.site_message} (delta={delta} new={new_crash} "
                    f"hist={len(hist_row)} max_id={max_id})"
                )
                return True
            self._log(
                f"settle wait {age:.1f}s phase={phase} saw_round={saw_round} "
                f"next_bet_for={since_next_bet:.1f}s delta={delta} new={new_crash} peak={peak:.2f}",
                repeat_s=3,
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
        try:
            return await asyncio.wait_for(
                self._place_bet_inner(page, stake, cashout), timeout=8.0
            )
        except asyncio.TimeoutError:
            self._log("place_bet fail: timed out finding/filling controls")
            return False

    async def _place_bet_inner(self, page, stake: float, cashout: float) -> bool:
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

        amount_loc = await self._input_near_label(page, r"^(Amount|Bet Amount|Stake)")
        if amount_loc is None:
            try:
                ph = page.get_by_placeholder(re.compile(r"amount|stake", re.I)).first
                if await ph.count() and await ph.is_visible():
                    amount_loc = ph
            except Exception:  # noqa: BLE001
                pass
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
            btn_sels = list(self.config.get("selectors", {}).get("bet_button", []) or [])
            btn_sels.extend(["button:has-text('Main Bet')", "button:has-text('Bet')"])
            btn_loc = await self._first_locator(page, btn_sels)

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

    async def _read_history_row(self, page) -> list[dict[str, float]]:
        """History pills: round id (9536465) + crash (1.00x). Newest = highest id."""
        try:
            val = await page.evaluate(
                """() => {
                  const xRe = /^(\\d+\\.\\d+)\\s*[x×]$/i;
                  const idRe = /^(\\d{5,10})$/;
                  const found = new Map();
                  const els = document.querySelectorAll('div, span, a, p, b');
                  for (const el of els) {
                    if (el.offsetParent === null) continue;
                    if (el.closest('input,label,form,textarea,[role="dialog"]')) continue;
                    const raw = (el.innerText || '').trim();
                    if (!raw || raw.length > 48) continue;
                    const t = raw.replace(/\\s+/g, ' ');
                    const r = el.getBoundingClientRect();
                    if (r.top < 0 || r.top > 520) continue;
                    if (r.width < 6 || r.height < 8) continue;
                    if (r.width > 200) continue;

                    let id = null, v = null;
                    let m = t.match(/^(\\d{5,10})\\s+(\\d+\\.\\d+)\\s*[x×]$/i);
                    if (m) {
                      id = Number(m[1]);
                      v = parseFloat(m[2]);
                    } else if (xRe.test(t) && el.children.length === 0) {
                      v = parseFloat(t);
                      const p = el.parentElement;
                      if (p) {
                        const pm = (p.innerText || '').replace(/\\s+/g, ' ').match(/(\\d{5,10})/);
                        if (pm) id = Number(pm[1]);
                      }
                      let sib = el.previousElementSibling;
                      for (let i = 0; i < 5 && sib && !id; i++) {
                        const st = (sib.innerText || '').trim();
                        if (idRe.test(st)) id = Number(st);
                        sib = sib.previousElementSibling;
                      }
                    } else if (idRe.test(t) && el.children.length === 0) {
                      id = Number(t);
                      let sib = el.nextElementSibling;
                      for (let i = 0; i < 5 && sib && v == null; i++) {
                        const st = (sib.innerText || '').trim();
                        const xm = st.match(xRe);
                        if (xm) v = parseFloat(xm[1]);
                        sib = sib.nextElementSibling;
                      }
                    }
                    if (id && v >= 1 && v < 1000000) {
                      const prev = found.get(id);
                      if (!prev || r.width * r.height < prev.area) {
                        found.set(id, { id, v, area: r.width * r.height });
                      }
                    }
                  }
                  return Array.from(found.values())
                    .sort((a, b) => a.id - b.id)
                    .slice(-24)
                    .map((c) => ({ id: c.id, v: c.v }));
                }"""
            )
            if isinstance(val, list):
                out: list[dict[str, float]] = []
                for item in val:
                    if isinstance(item, dict) and "v" in item:
                        out.append({"id": float(item.get("id") or 0), "v": float(item["v"])})
                    elif isinstance(item, (int, float)):
                        out.append({"id": 0.0, "v": float(item)})
                return out
        except Exception:  # noqa: BLE001
            pass
        return []

    async def _read_latest_history_crash(self, page) -> float | None:
        row = await self._read_history_row(page)
        return float(row[-1]["v"]) if row else None

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
