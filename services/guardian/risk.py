"""Position Guardian risk model. Pure integer math, no network, no keys.

Answers one question for a collateralised debt position: how far can the
collateral price fall before the protocol allows liquidation?

    distance_bps = (price - liquidation_price) / price, in basis points

Two entry points produce the same Assessment:
  * assess_collateral_ratio: protocols with a minimum collateral ratio
    (Liquity: liquidatable when coll * price / debt < MCR);
  * assess_health_factor: protocols that publish a health factor
    (Aave: liquidatable when HF < 1).

Rules that keep alerts honest:
  * Unknown or stale inputs give level UNKNOWN. They never give SAFE.
  * Levels use hysteresis, so a position sitting on a boundary does not
    flap between two levels and spam alerts.
  * This is information, not advice, and not a guarantee that a liquidation
    will be preceded by an alert: prices can gap between observations.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

SCALE = 10 ** 18
BPS = 10_000

LEVEL_NO_DEBT = "NO_DEBT"
LEVEL_SAFE = "SAFE"
LEVEL_WATCH = "WATCH"
LEVEL_DANGER = "DANGER"
LEVEL_CRITICAL = "CRITICAL"
LEVEL_LIQUIDATABLE = "LIQUIDATABLE"
LEVEL_UNKNOWN = "UNKNOWN"

# Severity order for escalation decisions. UNKNOWN is handled separately.
SEVERITY = {LEVEL_NO_DEBT: 0, LEVEL_SAFE: 0, LEVEL_WATCH: 1, LEVEL_DANGER: 2,
            LEVEL_CRITICAL: 3, LEVEL_LIQUIDATABLE: 4}

REASON_PRICE_UNKNOWN = "PRICE_UNKNOWN"
REASON_DATA_STALE = "DATA_STALE"
REASON_INVALID_INPUT = "INVALID_INPUT"
REASON_ZERO_COLLATERAL = "ZERO_COLLATERAL_WITH_DEBT"


@dataclass(frozen=True)
class Thresholds:
    """Distance to liquidation, in bps of the current price, at which each level starts.
    Defaults: watch at 25%, danger at 10%, critical at 3%."""
    watch_bps: int = 2500
    danger_bps: int = 1000
    critical_bps: int = 300
    # To step DOWN a level the distance must clear the boundary by this margin.
    hysteresis_bps: int = 100
    # Observations older than this are not trusted.
    max_data_age_seconds: int = 900

    def __post_init__(self):
        values = (self.critical_bps, self.danger_bps, self.watch_bps)
        if any(isinstance(v, bool) or not isinstance(v, int) for v in values + (self.hysteresis_bps, self.max_data_age_seconds)):
            raise ValueError("thresholds must be integers")
        if not 0 < self.critical_bps < self.danger_bps < self.watch_bps < BPS:
            raise ValueError("need 0 < critical < danger < watch < 10000 bps")
        if not 0 <= self.hysteresis_bps < self.critical_bps:
            raise ValueError("hysteresis must be >= 0 and smaller than the critical threshold")
        if self.max_data_age_seconds <= 0:
            raise ValueError("max_data_age_seconds must be positive")


@dataclass(frozen=True)
class Assessment:
    level: str
    distance_bps: Optional[int]          # None when unknown or no debt
    liquidation_price: Optional[int]     # same units as the input price; None when unknown
    reasons: tuple = ()

    @property
    def known(self) -> bool:
        return self.level != LEVEL_UNKNOWN


def _unknown(*reasons: str) -> Assessment:
    return Assessment(LEVEL_UNKNOWN, None, None, tuple(reasons))


def _is_uint(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _raw_level(distance_bps: int, t: Thresholds) -> str:
    # LIQUIDATABLE is decided only by the protocol's own rule in the callers.
    # Distance 0 here means "at the boundary but not past it", which is CRITICAL.
    if distance_bps <= t.critical_bps:
        return LEVEL_CRITICAL
    if distance_bps <= t.danger_bps:
        return LEVEL_DANGER
    if distance_bps <= t.watch_bps:
        return LEVEL_WATCH
    return LEVEL_SAFE


def _level_with_hysteresis(distance_bps: int, t: Thresholds, previous_level: Optional[str]) -> str:
    """Escalation is immediate. De-escalation needs the distance to clear the
    previous level's upper boundary by the hysteresis margin."""
    raw = _raw_level(distance_bps, t)
    if previous_level not in SEVERITY or SEVERITY[raw] >= SEVERITY[previous_level]:
        return raw
    # LIQUIDATABLE is a fact about the protocol rule, not a band: no hysteresis.
    upper = {LEVEL_CRITICAL: t.critical_bps, LEVEL_DANGER: t.danger_bps,
             LEVEL_WATCH: t.watch_bps}.get(previous_level)
    if upper is not None and distance_bps <= upper + t.hysteresis_bps:
        return previous_level
    return raw


def _stale(observed_at: Optional[int], now: Optional[int], t: Thresholds) -> bool:
    if observed_at is None or now is None:
        return False
    return now - observed_at > t.max_data_age_seconds or observed_at > now + 60


def assess_collateral_ratio(collateral: int, debt: int, price: Optional[int], min_ratio: int,
                            thresholds: Thresholds = Thresholds(), previous_level: Optional[str] = None,
                            observed_at: Optional[int] = None, now: Optional[int] = None) -> Assessment:
    """collateral and debt in atomic units; price and min_ratio scaled by 1e18.
    Liquidatable when collateral * price // debt < min_ratio (Liquity's ICR < MCR)."""
    if not _is_uint(collateral) or not _is_uint(debt) or not _is_uint(min_ratio) or min_ratio <= SCALE:
        return _unknown(REASON_INVALID_INPUT)
    if debt == 0:
        return Assessment(LEVEL_NO_DEBT, None, None)
    if _stale(observed_at, now, thresholds):
        return _unknown(REASON_DATA_STALE)
    if price is None:
        return _unknown(REASON_PRICE_UNKNOWN)
    if not _is_uint(price) or price == 0:
        return _unknown(REASON_INVALID_INPUT)
    if collateral == 0:
        return Assessment(LEVEL_LIQUIDATABLE, 0, None, (REASON_ZERO_COLLATERAL,))
    # Highest price at which the position is still below the minimum ratio.
    liquidation_price = (debt * min_ratio - 1) // collateral
    if collateral * price // debt < min_ratio:
        return Assessment(LEVEL_LIQUIDATABLE, 0, liquidation_price)
    distance = (price - liquidation_price) * BPS // price
    return Assessment(_level_with_hysteresis(distance, thresholds, previous_level), distance, liquidation_price)


def assess_health_factor(health_factor: Optional[int], thresholds: Thresholds = Thresholds(),
                         previous_level: Optional[str] = None, has_debt: bool = True,
                         observed_at: Optional[int] = None, now: Optional[int] = None) -> Assessment:
    """health_factor scaled by 1e18; liquidatable below 1e18 (Aave).
    distance = 1 - 1/HF: the uniform fall in collateral value that brings HF to 1.
    It is exact for one volatile collateral against stable debt and an
    approximation for mixed positions. No liquidation price is returned."""
    if not has_debt:
        return Assessment(LEVEL_NO_DEBT, None, None)
    if _stale(observed_at, now, thresholds):
        return _unknown(REASON_DATA_STALE)
    if health_factor is None:
        return _unknown(REASON_PRICE_UNKNOWN)
    if not _is_uint(health_factor):
        return _unknown(REASON_INVALID_INPUT)
    if health_factor < SCALE:
        return Assessment(LEVEL_LIQUIDATABLE, 0, None)
    distance = (health_factor - SCALE) * BPS // health_factor
    return Assessment(_level_with_hysteresis(distance, thresholds, previous_level), distance, None)


# ------------------------------------------------------------------ alert policy

ALERT_ESCALATED = "ESCALATED"
ALERT_REMINDER = "REMINDER"
ALERT_RECOVERED = "RECOVERED"
ALERT_DATA_UNAVAILABLE = "DATA_UNAVAILABLE"
ALERT_DATA_RESTORED = "DATA_RESTORED"

REMINDER_SECONDS = {LEVEL_DANGER: 6 * 3600, LEVEL_CRITICAL: 3600, LEVEL_LIQUIDATABLE: 3600}


@dataclass(frozen=True)
class AlertState:
    """What the user was last told. Persist this per watched position."""
    level: Optional[str] = None          # last known (non-UNKNOWN) level told to the user
    last_alert_at: Optional[int] = None
    data_unavailable: bool = False       # user has been told data is unavailable


@dataclass(frozen=True)
class Decision:
    alert: Optional[str]
    state: AlertState


def decide_alert(state: AlertState, assessment: Assessment, now: int) -> Decision:
    """Decides whether to notify, and returns the state to store.

    * UNKNOWN: tell the user once that monitoring is blind; keep the last known
      level so a later reading is compared against what they were told.
    * Escalation: always alert. A first reading at SAFE or NO_DEBT is silent.
    * Same level at DANGER or worse: remind on a fixed interval.
    * De-escalation to SAFE or NO_DEBT: one RECOVERED message. Partial
      de-escalation (CRITICAL -> WATCH) is silent to avoid noise.
    """
    if not assessment.known:
        if state.data_unavailable:
            return Decision(None, state)
        return Decision(ALERT_DATA_UNAVAILABLE, AlertState(state.level, now, True))

    level = assessment.level
    restored = state.data_unavailable
    previous = state.level
    if previous is None:
        alert = ALERT_ESCALATED if SEVERITY[level] > 0 else (ALERT_DATA_RESTORED if restored else None)
        return Decision(alert, AlertState(level, now if alert else state.last_alert_at, False))
    if SEVERITY[level] > SEVERITY[previous]:
        return Decision(ALERT_ESCALATED, AlertState(level, now, False))
    if SEVERITY[level] < SEVERITY[previous]:
        if SEVERITY[level] == 0:
            return Decision(ALERT_RECOVERED, AlertState(level, now, False))
        return Decision(ALERT_DATA_RESTORED if restored else None,
                        AlertState(level, now if restored else state.last_alert_at, False))
    interval = REMINDER_SECONDS.get(level)
    if interval is not None and (state.last_alert_at is None or now - state.last_alert_at >= interval):
        return Decision(ALERT_REMINDER, AlertState(level, now, False))
    if restored:
        return Decision(ALERT_DATA_RESTORED, AlertState(level, now, False))
    return Decision(None, AlertState(level, state.last_alert_at, False))


def price_drop_percent(assessment: Assessment) -> Optional[str]:
    """Human-readable distance, e.g. '12.34'. None when unknown."""
    if assessment.distance_bps is None:
        return None
    return f"{assessment.distance_bps // 100}.{assessment.distance_bps % 100:02d}"


def worst(levels: List[str]) -> Optional[str]:
    known = [lvl for lvl in levels if lvl in SEVERITY]
    return max(known, key=lambda lvl: SEVERITY[lvl]) if known else None
