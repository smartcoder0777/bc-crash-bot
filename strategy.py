"""Strategy state machine for BC Crash custom martingale."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class Mode(str, Enum):
    NORMAL = "normal"
    RESTING = "resting"
    RECOVERY = "recovery"
    STOPPED = "stopped"


@dataclass
class StrategyConfig:
    base_stake: float = 0.2
    cashout: float = 1.45
    loss_multiplier: float = 3.15
    losses_before_rest: int = 4
    rest_rounds: int = 10
    recovery_attempts: int = 2
    stop_loss: float = 50.0
    start_balance: float = 0.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StrategyConfig":
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class StrategyState:
    mode: Mode = Mode.NORMAL
    current_stake: float = 0.2
    consecutive_losses: int = 0
    rest_remaining: int = 0
    recovery_left: int = 0
    recovery_stake: float = 0.0
    last_lost_amount: float = 0.0
    session_pnl: float = 0.0
    total_won: float = 0.0
    total_lost: float = 0.0
    bets_placed: int = 0
    wins: int = 0
    losses: int = 0
    last_result: str = "-"
    last_crash: float | None = None
    last_multiplier_seen: float | None = None
    message: str = "Idle"
    history: list[dict[str, Any]] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        return {
            "mode": self.mode.value,
            "current_stake": round(self.current_stake, 8),
            "consecutive_losses": self.consecutive_losses,
            "rest_remaining": self.rest_remaining,
            "recovery_left": self.recovery_left,
            "recovery_stake": round(self.recovery_stake, 8),
            "last_lost_amount": round(self.last_lost_amount, 8),
            "session_pnl": round(self.session_pnl, 8),
            "total_won": round(self.total_won, 8),
            "total_lost": round(self.total_lost, 8),
            "bets_placed": self.bets_placed,
            "wins": self.wins,
            "losses": self.losses,
            "last_result": self.last_result,
            "last_crash": self.last_crash,
            "last_multiplier_seen": self.last_multiplier_seen,
            "message": self.message,
            "history": list(self.history),
        }


class StrategyEngine:
    def __init__(self, config: StrategyConfig):
        self.config = config
        self.state = StrategyState(current_stake=config.base_stake)

    def snapshot(self) -> dict[str, Any]:
        data = self.state.snapshot()
        start = float(self.config.start_balance)
        data["start_balance"] = round(start, 8)
        data["current_balance"] = round(start + self.state.session_pnl, 8)
        return data

    def set_start_balance(self, amount: float) -> None:
        self.config.start_balance = float(amount)
        if amount > 0:
            self.state.message = f"Start balance from site: {amount}"

    def update_config(self, data: dict[str, Any]) -> None:
        self.config = StrategyConfig.from_dict({**self.config.to_dict(), **data})
        if self.state.mode == Mode.NORMAL and self.state.consecutive_losses == 0:
            self.state.current_stake = self.config.base_stake

    def reset(self) -> None:
        self.config.start_balance = 0.0
        self.state = StrategyState(
            current_stake=self.config.base_stake,
            message="Reset — all session values cleared",
        )

    def should_bet(self) -> bool:
        if self.state.mode == Mode.STOPPED:
            return False
        if self.state.mode == Mode.RESTING:
            return False
        if self._hit_stop_loss():
            self._stop("Stop-loss reached")
            return False
        return True

    def next_bet(self) -> dict[str, float] | None:
        if not self.should_bet():
            return None
        stake = (
            self.state.recovery_stake
            if self.state.mode == Mode.RECOVERY
            else self.state.current_stake
        )
        return {"stake": round(stake, 8), "cashout": self.config.cashout}

    def on_round_skipped(self) -> None:
        """Call once per crash round while resting (no bet placed)."""
        if self.state.mode != Mode.RESTING:
            return
        self.state.rest_remaining = max(0, self.state.rest_remaining - 1)
        self.state.message = f"Resting… {self.state.rest_remaining} rounds left"
        if self.state.rest_remaining == 0:
            attempts = int(self.config.recovery_attempts)
            if attempts <= 0:
                self._stop("Rest done — recovery attempts is 0, bot stopped")
                return
            self.state.mode = Mode.RECOVERY
            self.state.recovery_stake = round(
                self.state.last_lost_amount * self.config.loss_multiplier, 8
            )
            self.state.recovery_left = attempts
            self.state.current_stake = self.state.recovery_stake
            self.state.message = (
                f"Recovery ready: bet {self.state.recovery_stake} "
                f"×{attempts} @ {self.config.cashout}x"
            )

    def on_bet_result(self, won: bool, stake: float, crash_at: float | None = None) -> None:
        cfg = self.config
        st = self.state
        st.bets_placed += 1
        st.last_crash = crash_at

        if won:
            profit = stake * (cfg.cashout - 1.0)
            st.session_pnl += profit
            st.total_won += profit
            st.wins += 1
            st.last_result = "win"
            st.history.append(
                {"result": "win", "stake": stake, "profit": round(profit, 8), "crash": crash_at}
            )
            st.consecutive_losses = 0
            st.mode = Mode.NORMAL
            st.current_stake = cfg.base_stake
            st.recovery_left = 0
            st.recovery_stake = 0.0
            st.message = f"Win +{profit:.4f} -> reset to base {cfg.base_stake}"
        else:
            st.session_pnl -= stake
            st.total_lost += stake
            st.losses += 1
            st.last_result = "lose"
            st.last_lost_amount = stake
            st.history.append(
                {"result": "lose", "stake": stake, "profit": round(-stake, 8), "crash": crash_at}
            )

            if st.mode == Mode.RECOVERY:
                st.recovery_left -= 1
                if st.recovery_left <= 0:
                    self._stop("Recovery failed twice — bot stopped")
                    return
                st.message = (
                    f"Recovery loss — {st.recovery_left} attempt(s) left "
                    f"at {st.recovery_stake}"
                )
                return

            # Normal mode loss
            st.consecutive_losses += 1
            if st.consecutive_losses >= cfg.losses_before_rest:
                st.mode = Mode.RESTING
                st.rest_remaining = cfg.rest_rounds
                st.message = (
                    f"{cfg.losses_before_rest} losses — resting {cfg.rest_rounds} rounds"
                )
            else:
                st.current_stake = round(stake * cfg.loss_multiplier, 8)
                st.message = (
                    f"Loss -> next stake {st.current_stake} "
                    f"({st.consecutive_losses}/{cfg.losses_before_rest})"
                )

        if self._hit_stop_loss():
            self._stop("Stop-loss reached")

    def _hit_stop_loss(self) -> bool:
        return self.state.session_pnl <= -abs(self.config.stop_loss)

    def _stop(self, reason: str) -> None:
        self.state.mode = Mode.STOPPED
        self.state.message = reason
