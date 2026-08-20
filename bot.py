"""Playwright controller: open BC.Game Crash, auto-fill stake/cashout, place bets."""

from __future__ import annotations

import asyncio
import re
import threading
import time
from typing import Any, Callable

from strategy import Mode, StrategyEngine


StatusCallback = Callable[[dict[str, Any]], None]


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
        self._browser = None
        self._page = None
        self._playwright = None
        self.live_multiplier: float | None = None
        self.site_message = "Browser not started"

    @property
    def running(self) -> bool:
        return self._running

    def status(self) -> dict[str, Any]:
        data = self.engine.state.snapshot()
        data.update(
            {
                "bot_running": self._running,
                "live_multiplier": self.live_multiplier,
                "site_message": self.site_message,
                "config": self.engine.config.to_dict(),
            }
        )
        return data

    def _emit(self) -> None:
        self.on_status(self.status())

    def start(self) -> None:
        if self._running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_thread, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._running = False
        self.site_message = "Stopping…"
        self._emit()

    def _run_thread(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        from playwright.async_api import async_playwright

        self._running = True
        self.site_message = "Launching browser…"
        self._emit()

        try:
            async with async_playwright() as p:
                self._playwright = p
                launch_args = {
                    "headless": bool(self.config.get("headless", False)),
                    "args": ["--start-maximized"],
                }
                # Prefer installed Google Chrome (no Playwright browser download needed)
                try:
                    self._browser = await p.chromium.launch(
                        channel="chrome", **launch_args
                    )
                except Exception:
                    self._browser = await p.chromium.launch(**launch_args)
                context = await self._browser.new_context(no_viewport=True)
                page = await context.new_page()
                self._page = page

                url = self.config.get("site_url", "https://bc.game/game/crash")
                await page.goto(url, wait_until="domcontentloaded")
                self.site_message = (
                    "Browser open — log in on the site, open Crash, then bot will auto-fill."
                )
                self._emit()

                # Give user time to log in / open game
                login_wait = 0
                while not self._stop.is_set() and login_wait < 120:
                    await asyncio.sleep(1)
                    login_wait += 1
                    if login_wait % 5 == 0:
                        self.site_message = (
                            f"Waiting for you to log in / open Crash… ({login_wait}s)"
                        )
                        self._emit()

                self.site_message = "Bot loop started — watching rounds"
                self._emit()

                last_phase = "unknown"
                pending_bet: dict[str, float] | None = None

                while not self._stop.is_set():
                    if self.engine.state.mode == Mode.STOPPED:
                        self.site_message = self.engine.state.message
                        self._emit()
                        await asyncio.sleep(1)
                        continue

                    mult = await self._read_multiplier(page)
                    if mult is not None:
                        self.live_multiplier = mult
                        self.engine.state.last_multiplier_seen = mult

                    phase = await self._detect_phase(page, mult)

                    # Entering betting window
                    if phase == "betting" and last_phase != "betting":
                        if self.engine.state.mode == Mode.RESTING:
                            self.engine.on_round_skipped()
                            self.site_message = self.engine.state.message
                            pending_bet = None
                        else:
                            pending_bet = self.engine.next_bet()
                            if pending_bet:
                                ok = await self._place_bet(
                                    page, pending_bet["stake"], pending_bet["cashout"]
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

                    # Round crashed / ended with pending bet
                    if phase == "crashed" and last_phase not in ("crashed", "unknown"):
                        if pending_bet is not None:
                            cashout = pending_bet["cashout"]
                            crash_at = mult if mult and mult >= 1.0 else None
                            # Win if crash multiplier reached cashout target
                            won = crash_at is not None and crash_at >= cashout
                            # Also try DOM result hints
                            hint = await self._result_hint(page)
                            if hint is not None:
                                won = hint
                            self.engine.on_bet_result(
                                won=won, stake=pending_bet["stake"], crash_at=crash_at
                            )
                            self.site_message = self.engine.state.message
                            pending_bet = None
                        elif self.engine.state.mode == Mode.RESTING:
                            # already counted on betting phase
                            pass

                    last_phase = phase
                    self._emit()
                    await asyncio.sleep(0.35)

                await context.close()
                await self._browser.close()
        except Exception as exc:  # noqa: BLE001
            self.site_message = f"Bot error: {exc}"
            self._emit()
        finally:
            self._running = False
            self._page = None
            self._browser = None
            if not self.site_message.startswith("Bot error"):
                self.site_message = "Bot stopped"
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

    async def _place_bet(self, page, stake: float, cashout: float) -> bool:
        selectors = self.config.get("selectors", {})
        amount_loc = await self._first_locator(page, selectors.get("bet_amount", []))
        cash_loc = await self._first_locator(page, selectors.get("cashout", []))
        btn_loc = await self._first_locator(page, selectors.get("bet_button", []))

        if amount_loc is None or btn_loc is None:
            # Fallback: try any visible number inputs
            inputs = page.locator("input:visible")
            count = await inputs.count()
            if count >= 1 and amount_loc is None:
                amount_loc = inputs.nth(0)
            if count >= 2 and cash_loc is None:
                cash_loc = inputs.nth(1)

        if amount_loc is None or btn_loc is None:
            return False

        try:
            await amount_loc.click()
            await amount_loc.fill("")
            await amount_loc.fill(self._fmt(stake))
            if cash_loc is not None:
                await cash_loc.click()
                await cash_loc.fill("")
                await cash_loc.fill(self._fmt(cashout))
            await btn_loc.click()
            return True
        except Exception as exc:  # noqa: BLE001
            self.site_message = f"Fill error: {exc}"
            return False

    @staticmethod
    def _fmt(value: float) -> str:
        text = f"{value:.8f}".rstrip("0").rstrip(".")
        return text if text else "0"

    async def _read_multiplier(self, page) -> float | None:
        selectors = self.config.get("selectors", {}).get("multiplier", [])
        for sel in selectors:
            loc = page.locator(sel).first
            try:
                if await loc.count() == 0:
                    continue
                text = (await loc.inner_text()).strip()
                m = re.search(r"(\d+\.?\d*)", text.replace(",", ""))
                if m:
                    return float(m.group(1))
            except Exception:  # noqa: BLE001
                continue

        # Broad fallback: look for "1.23x" style text
        try:
            body = await page.locator("body").inner_text()
            matches = re.findall(r"(\d+\.\d{2})\s*x", body, flags=re.I)
            if matches:
                # Prefer values that look like live crash multipliers
                vals = [float(x) for x in matches if 1.0 <= float(x) <= 100000]
                if vals:
                    return max(vals) if len(vals) < 5 else vals[0]
        except Exception:  # noqa: BLE001
            pass
        return None

    async def _detect_phase(self, page, mult: float | None) -> str:
        """Heuristic phases: betting | flying | crashed."""
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
        # Very rough; prefer multiplier comparison
        if "you won" in text or "cashed out" in text:
            return True
        if "you lost" in text:
            return False
        return None
