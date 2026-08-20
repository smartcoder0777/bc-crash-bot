"""Parse BC.Game Crash-related WebSocket / network payloads."""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class BetOutcome:
    won: bool
    crash_at: float | None
    game_id: str | None
    source: str
    ts: float


class CrashNetworkFeed:
    """Thread-safe feed of crash points and bet outcomes from page network traffic."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.live_multiplier: float | None = None
        self.phase_hint: str | None = None  # betting | flying | crashed
        self.last_crash: float | None = None
        self.last_crash_id: str | None = None
        self.crash_seq: int = 0
        self._outcomes: list[BetOutcome] = []
        self._seen_crash_ids: set[str] = set()
        self.frames_seen: int = 0
        self.last_raw_hint: str = ""
        self._last_crash_ts: float = 0.0

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "live_multiplier": self.live_multiplier,
                "phase_hint": self.phase_hint,
                "last_crash": self.last_crash,
                "last_crash_id": self.last_crash_id,
                "crash_seq": self.crash_seq,
                "frames_seen": self.frames_seen,
                "pending_outcomes": len(self._outcomes),
            }

    def handle_frame(self, payload: str | bytes) -> None:
        if payload is None:
            return
        if isinstance(payload, bytes):
            try:
                payload = payload.decode("utf-8", errors="ignore")
            except Exception:  # noqa: BLE001
                return
        text = payload.strip()
        if not text or len(text) > 500_000:
            return
        with self._lock:
            self.frames_seen += 1
        self._ingest_text(text)

    def wait_crash_after(self, min_seq: int, timeout: float = 8.0) -> tuple[float | None, str | None, int]:
        """Wait until a new crash arrives with seq > min_seq."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if self.crash_seq > min_seq and self.last_crash is not None:
                    return self.last_crash, self.last_crash_id, self.crash_seq
            time.sleep(0.05)
        with self._lock:
            if self.crash_seq > min_seq:
                return self.last_crash, self.last_crash_id, self.crash_seq
        return None, None, min_seq

    def pop_outcome_since(self, since_ts: float) -> BetOutcome | None:
        with self._lock:
            for i, o in enumerate(self._outcomes):
                if o.ts >= since_ts - 0.5:
                    return self._outcomes.pop(i)
            return None

    def note_crash(self, crash: float, game_id: str | None = None, source: str = "net") -> None:
        if crash is None or crash < 1.0:
            return
        with self._lock:
            if game_id and game_id in self._seen_crash_ids:
                return
            if game_id:
                self._seen_crash_ids.add(game_id)
                if len(self._seen_crash_ids) > 500:
                    self._seen_crash_ids = set(list(self._seen_crash_ids)[-200:])
            # Dedup only identical id, or same value within 1.5s (retransmits).
            # Same crash multiplier on a later round must still count.
            now = time.time()
            if (
                game_id is None
                and self.last_crash is not None
                and abs(self.last_crash - crash) < 1e-9
                and getattr(self, "_last_crash_ts", 0)
                and now - self._last_crash_ts < 1.5
            ):
                return
            self.last_crash = float(crash)
            self.last_crash_id = game_id
            self._last_crash_ts = now
            self.crash_seq += 1
            self.phase_hint = "crashed"
            self.last_raw_hint = f"{source}:{crash}"

    def note_outcome(self, won: bool, crash_at: float | None = None, game_id: str | None = None, source: str = "net") -> None:
        with self._lock:
            self._outcomes.append(
                BetOutcome(
                    won=won,
                    crash_at=crash_at,
                    game_id=game_id,
                    source=source,
                    ts=time.time(),
                )
            )
            if len(self._outcomes) > 50:
                self._outcomes = self._outcomes[-30:]

    def _ingest_text(self, text: str) -> None:
        # Try JSON first
        objs: list[Any] = []
        if text[0] in "{[":
            try:
                objs.append(json.loads(text))
            except Exception:  # noqa: BLE001
                # Socket.IO style: 42["event",{...}]
                m = re.search(r"\d+(\[.*\])\s*$", text, re.S)
                if m:
                    try:
                        objs.append(json.loads(m.group(1)))
                    except Exception:  # noqa: BLE001
                        pass
        for obj in objs:
            self._walk(obj)

        # Regex fallbacks on raw text
        low = text.lower()
        if "waiting" in low or "start" in low and "bet" in low:
            with self._lock:
                if self.phase_hint != "crashed":
                    self.phase_hint = "betting"
        if "flying" in low or "inplay" in low or "in_play" in low:
            with self._lock:
                self.phase_hint = "flying"

        for pat in (
            r'"crash(?:Point|_point|edAt)?"\s*:\s*"?(\d+\.?\d*)"?',
            r'"bust(?:edAt|Point)?"\s*:\s*"?(\d+\.?\d*)"?',
            r'"multiplier"\s*:\s*"?(\d+\.?\d*)"?\s*.{0,40}"(?:crash|bust|end)"',
            r'crash(?:ed)?[^\d]{0,12}(\d+\.\d+)\s*x',
        ):
            m = re.search(pat, text, re.I)
            if m:
                try:
                    val = float(m.group(1))
                except ValueError:
                    continue
                if 1.0 <= val <= 1_000_000:
                    gid = None
                    gm = re.search(r'"game(?:Id|_id|ID)?"\s*:\s*"?(\d+)"?', text)
                    if gm:
                        gid = gm.group(1)
                    self.note_crash(val, gid, source="regex")
                    break

        # Explicit cashout / win / lose flags near our bet
        if re.search(r'"cashedOut"\s*:\s*true', text, re.I) or re.search(
            r'"won"\s*:\s*true', text, re.I
        ):
            crash = self.last_crash
            self.note_outcome(True, crash, source="flag-win")
        if re.search(r'"cashedOut"\s*:\s*false', text, re.I) and re.search(
            r'"(?:bust|crash|lost|lose)"', text, re.I
        ):
            self.note_outcome(False, self.last_crash, source="flag-lose")

    def _walk(self, obj: Any, depth: int = 0) -> None:
        if depth > 8:
            return
        if isinstance(obj, list):
            for item in obj:
                self._walk(item, depth + 1)
            return
        if not isinstance(obj, dict):
            return

        lower = {str(k).lower(): v for k, v in obj.items()}

        # Live multiplier while flying
        for key in ("multiplier", "currentmultiplier", "current_multiplier", "rate"):
            if key in lower and isinstance(lower[key], (int, float)):
                val = float(lower[key])
                if 1.0 <= val <= 1_000_000:
                    with self._lock:
                        self.live_multiplier = val
                        if val > 1.01 and self.phase_hint != "crashed":
                            self.phase_hint = "flying"

        # Crash point
        crash_val = None
        for key in (
            "crashpoint",
            "crash_point",
            "crash",
            "bust",
            "bustedat",
            "bustpoint",
            "explode",
            "endedat",
        ):
            if key in lower and isinstance(lower[key], (int, float, str)):
                try:
                    crash_val = float(lower[key])
                except (TypeError, ValueError):
                    continue
                break

        typ = str(lower.get("type") or lower.get("event") or lower.get("action") or lower.get("op") or "").lower()
        status = str(lower.get("status") or lower.get("state") or "").lower()
        game_id = None
        for key in ("gameid", "game_id", "id", "roundid", "round_id"):
            if key in lower and lower[key] is not None:
                game_id = str(lower[key])
                break

        if crash_val is not None and 1.0 <= crash_val <= 1_000_000:
            if any(
                s in typ or s in status
                for s in ("crash", "bust", "end", "settle", "finish", "over")
            ) or "crashpoint" in lower or "bust" in lower:
                self.note_crash(crash_val, game_id, source="json")

        # Phase hints
        if any(s in typ or s in status for s in ("wait", "bet", "start", "accept")):
            with self._lock:
                self.phase_hint = "betting"
        if any(s in typ or s in status for s in ("fly", "run", "play", "progress")):
            with self._lock:
                self.phase_hint = "flying"

        # Bet result
        won = None
        if "cashedout" in lower:
            if lower["cashedout"] is True:
                won = True
            elif lower["cashedout"] is False and (
                "crash" in typ or "bust" in typ or crash_val is not None
            ):
                won = False
        if "won" in lower and isinstance(lower["won"], bool):
            won = lower["won"]
        if "iswin" in lower and isinstance(lower["iswin"], bool):
            won = lower["iswin"]
        if won is not None:
            self.note_outcome(won, crash_val or self.last_crash, game_id, source="json")

        for v in obj.values():
            if isinstance(v, (dict, list)):
                self._walk(v, depth + 1)
