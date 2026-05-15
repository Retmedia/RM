"""Equity options signal bot with 2-hour exit alerts.

Scans a watchlist of liquid US equities during market hours, fires
BUY CALL / BUY PUT alerts when a defined intraday setup triggers,
suggests a strike + expiry, then tracks the underlying and alerts
when the position should be exited (target hit, stop hit, or 2hr
timeout). All output goes to the console + CSV. No orders are placed
anywhere — you manually act on the alerts in your broker.

Run during US market hours (9:30 ET - 16:00 ET, weekdays).
Outside market hours it sleeps.
"""

from __future__ import annotations

import csv
import logging
import time
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

WATCHLIST = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "AMD", "META", "MSFT", "AMZN", "GOOG"]

SCAN_INTERVAL_SEC = 60          # how often to scan the watchlist
PER_SYMBOL_DELAY_SEC = 1.5      # be gentle on yfinance
DEDUPE_MINUTES = 30             # don't re-fire the same symbol within this window

MARKET_TZ = ZoneInfo("America/New_York")
MARKET_OPEN = dtime(9, 30)
MARKET_CLOSE = dtime(16, 0)

# Setup thresholds
MIN_GAP_PCT = 1.0               # opening gap must be >= this
MIN_REL_VOL = 1.5               # extrapolated daily volume vs 20d avg
ORB_MINUTES = 15                # opening range window for breakout setup

# Per-trade rules
MAX_HOLD_MINUTES = 120          # forced exit at 2 hours
STOP_PCT = 0.5                  # underlying move against you to stop
TARGET_PCT = 1.0                # underlying move in your favor to take profit

SIGNAL_LOG = Path(__file__).with_name("signals.csv")
EXIT_LOG = Path(__file__).with_name("exits.csv")

log = logging.getLogger("options_signals")


# --------------------------------------------------------------------------
# Data structures
# --------------------------------------------------------------------------

@dataclass
class Signal:
    ts: datetime
    symbol: str
    direction: str          # "CALL" or "PUT"
    setup: str
    score: float
    entry_price: float
    stop_price: float
    target_price: float
    expiry: Optional[str] = None
    strike: Optional[float] = None
    option_bid: Optional[float] = None
    option_ask: Optional[float] = None
    option_iv: Optional[float] = None


@dataclass
class ActivePosition:
    signal: Signal
    exit_deadline: datetime
    status: str = "open"    # "open", "target", "stop", "timeout"


# --------------------------------------------------------------------------
# Market hours
# --------------------------------------------------------------------------

def in_market_hours(now_et: datetime) -> bool:
    if now_et.weekday() >= 5:
        return False
    return MARKET_OPEN <= now_et.time() <= MARKET_CLOSE


# --------------------------------------------------------------------------
# Indicators
# --------------------------------------------------------------------------

def compute_vwap(bars: pd.DataFrame) -> float:
    typical = (bars["High"] + bars["Low"] + bars["Close"]) / 3
    vol = bars["Volume"].sum()
    if vol <= 0:
        return float(bars["Close"].iloc[-1])
    return float((typical * bars["Volume"]).sum() / vol)


def compute_rsi(prices: pd.Series, period: int = 14) -> float:
    if len(prices) < period + 1:
        return 50.0
    delta = prices.diff()
    gain = delta.where(delta > 0, 0.0).rolling(period).mean().iloc[-1]
    loss = (-delta.where(delta < 0, 0.0)).rolling(period).mean().iloc[-1]
    if pd.isna(gain) or pd.isna(loss):
        return 50.0
    if loss == 0:
        return 100.0 if gain > 0 else 50.0
    rs = gain / loss
    return float(100 - (100 / (1 + rs)))


# --------------------------------------------------------------------------
# Signal generation
# --------------------------------------------------------------------------

def score_symbol(symbol: str) -> Optional[Signal]:
    """Return a Signal if any setup fires for this symbol, else None."""
    try:
        ticker = yf.Ticker(symbol)
        intraday = ticker.history(period="1d", interval="1m")
        daily = ticker.history(period="25d", interval="1d")
    except Exception as e:
        log.debug("data fetch failed for %s: %s", symbol, e)
        return None

    if intraday.empty or len(intraday) < ORB_MINUTES + 5:
        return None
    if daily.empty or len(daily) < 5:
        return None

    last = float(intraday["Close"].iloc[-1])
    open_price = float(intraday["Open"].iloc[0])
    yesterday_close = float(daily["Close"].iloc[-2])
    if yesterday_close <= 0:
        return None
    gap_pct = (open_price - yesterday_close) / yesterday_close * 100

    vwap = compute_vwap(intraday)
    rsi = compute_rsi(intraday["Close"])

    avg_daily_vol = float(daily["Volume"].iloc[-20:].mean())
    today_vol = float(intraday["Volume"].sum())
    elapsed_min = max(1, len(intraday))
    extrapolated = today_vol / elapsed_min * 390
    rel_vol = extrapolated / avg_daily_vol if avg_daily_vol > 0 else 0.0

    orb = intraday.iloc[:ORB_MINUTES]
    orb_high = float(orb["High"].max())
    orb_low = float(orb["Low"].min())

    setup: Optional[str] = None
    direction: Optional[str] = None
    score = 0.0

    # Setup 1: gap + above/below VWAP with volume
    if abs(gap_pct) >= MIN_GAP_PCT and rel_vol >= MIN_REL_VOL:
        if gap_pct > 0 and last > vwap and rsi < RSI_OVERBOUGHT_GUARD:
            setup, direction = "gap_up_vwap", "CALL"
            score = abs(gap_pct) + (rel_vol - 1) * 2
        elif gap_pct < 0 and last < vwap and rsi > RSI_OVERSOLD_GUARD:
            setup, direction = "gap_down_vwap", "PUT"
            score = abs(gap_pct) + (rel_vol - 1) * 2

    # Setup 2: opening-range breakout (only after ORB window completes)
    if setup is None and len(intraday) > ORB_MINUTES + 5:
        if last > orb_high * 1.001 and rel_vol >= MIN_REL_VOL:
            setup, direction = "orb_break_up", "CALL"
            score = (last - orb_high) / orb_high * 100 + (rel_vol - 1)
        elif last < orb_low * 0.999 and rel_vol >= MIN_REL_VOL:
            setup, direction = "orb_break_down", "PUT"
            score = (orb_low - last) / orb_low * 100 + (rel_vol - 1)

    if setup is None or direction is None:
        return None

    expiry, strike, bid, ask, iv = pick_option(ticker, last, direction)

    if direction == "CALL":
        stop_price = last * (1 - STOP_PCT / 100)
        target_price = last * (1 + TARGET_PCT / 100)
    else:
        stop_price = last * (1 + STOP_PCT / 100)
        target_price = last * (1 - TARGET_PCT / 100)

    return Signal(
        ts=datetime.now(timezone.utc),
        symbol=symbol,
        direction=direction,
        setup=setup,
        score=score,
        entry_price=last,
        stop_price=stop_price,
        target_price=target_price,
        expiry=expiry,
        strike=strike,
        option_bid=bid,
        option_ask=ask,
        option_iv=iv,
    )


# Filters to avoid chasing into exhausted moves
RSI_OVERBOUGHT_GUARD = 78
RSI_OVERSOLD_GUARD = 22


def pick_option(ticker, underlying_price: float, direction: str):
    """Pick the nearest weekly expiry (>= 2 DTE) and the ATM strike.

    Returns (expiry_str, strike, bid, ask, iv) — any may be None if the
    chain isn't available.
    """
    try:
        expiries = ticker.options
        if not expiries:
            return None, None, None, None, None
        today = datetime.now().date()
        candidates = [
            e for e in expiries
            if (datetime.strptime(e, "%Y-%m-%d").date() - today).days >= 2
        ]
        expiry = candidates[0] if candidates else expiries[0]
        chain = ticker.option_chain(expiry)
        df = chain.calls if direction == "CALL" else chain.puts
        if df.empty:
            return expiry, None, None, None, None
        df = df.assign(diff=(df["strike"] - underlying_price).abs())
        row = df.sort_values("diff").iloc[0]
        return (
            expiry,
            float(row["strike"]),
            float(row["bid"]) if pd.notna(row.get("bid")) else None,
            float(row["ask"]) if pd.notna(row.get("ask")) else None,
            float(row["impliedVolatility"]) if pd.notna(row.get("impliedVolatility")) else None,
        )
    except Exception as e:
        log.debug("option chain error: %s", e)
        return None, None, None, None, None


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------

SIGNAL_FIELDS = [
    "ts", "symbol", "direction", "setup", "score",
    "entry", "stop", "target",
    "expiry", "strike", "bid", "ask", "iv",
]
EXIT_FIELDS = [
    "ts", "symbol", "direction", "reason",
    "entry", "exit", "underlying_pnl_pct",
]


def append_csv(path: Path, fieldnames: list[str], row: dict) -> None:
    new = not path.exists()
    with path.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        if new:
            w.writeheader()
        w.writerow(row)


def log_signal(s: Signal) -> None:
    append_csv(SIGNAL_LOG, SIGNAL_FIELDS, {
        "ts": s.ts.isoformat(timespec="seconds"),
        "symbol": s.symbol,
        "direction": s.direction,
        "setup": s.setup,
        "score": round(s.score, 3),
        "entry": round(s.entry_price, 2),
        "stop": round(s.stop_price, 2),
        "target": round(s.target_price, 2),
        "expiry": s.expiry or "",
        "strike": s.strike if s.strike is not None else "",
        "bid": s.option_bid if s.option_bid is not None else "",
        "ask": s.option_ask if s.option_ask is not None else "",
        "iv": round(s.option_iv, 4) if s.option_iv is not None else "",
    })


def log_exit(pos: ActivePosition, exit_price: float, reason: str) -> None:
    sign = 1 if pos.signal.direction == "CALL" else -1
    pnl_pct = sign * (exit_price - pos.signal.entry_price) / pos.signal.entry_price * 100
    append_csv(EXIT_LOG, EXIT_FIELDS, {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "symbol": pos.signal.symbol,
        "direction": pos.signal.direction,
        "reason": reason,
        "entry": round(pos.signal.entry_price, 2),
        "exit": round(exit_price, 2),
        "underlying_pnl_pct": round(pnl_pct, 3),
    })


# --------------------------------------------------------------------------
# Pretty printing
# --------------------------------------------------------------------------

def announce_signal(s: Signal, now_et: datetime) -> None:
    exit_at = (now_et + timedelta(minutes=MAX_HOLD_MINUTES)).strftime("%H:%M")
    log.info("")
    log.info("=" * 64)
    log.info("  SIGNAL  %s  %s   setup=%s   score=%.2f",
             s.symbol, s.direction, s.setup, s.score)
    log.info("  underlying: entry=%.2f  stop=%.2f  target=%.2f",
             s.entry_price, s.stop_price, s.target_price)
    if s.strike is not None:
        bid = f"{s.option_bid:.2f}" if s.option_bid is not None else "—"
        ask = f"{s.option_ask:.2f}" if s.option_ask is not None else "—"
        iv = f"{s.option_iv * 100:.1f}%" if s.option_iv is not None else "—"
        log.info("  option:    %s %s  $%g  bid=%s ask=%s IV=%s",
                 s.symbol, s.expiry, s.strike, bid, ask, iv)
    else:
        log.info("  option chain unavailable — check your broker for nearest "
                 "weekly %s strike ~%.2f", s.direction, s.entry_price)
    log.info("  exit by:   %s ET  (2hr max hold)", exit_at)
    log.info("=" * 64)
    log.info("")


def announce_exit(pos: ActivePosition, price: float, reason: str) -> None:
    sign = 1 if pos.signal.direction == "CALL" else -1
    move = sign * (price - pos.signal.entry_price) / pos.signal.entry_price * 100
    log.info("")
    log.info(">>> EXIT  %s %s  @ %.2f   %s   underlying_move=%+.2f%%",
             pos.signal.symbol, pos.signal.direction, price, reason, move)
    log.info("")


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

def get_last_price(symbol: str) -> Optional[float]:
    try:
        bars = yf.Ticker(symbol).history(period="1d", interval="1m")
        if bars.empty:
            return None
        return float(bars["Close"].iloc[-1])
    except Exception:
        return None


def update_positions(positions: list[ActivePosition]) -> None:
    for pos in positions:
        if pos.status != "open":
            continue
        price = get_last_price(pos.signal.symbol)
        if price is None:
            continue
        reason: Optional[str] = None
        if pos.signal.direction == "CALL":
            if price >= pos.signal.target_price:
                reason = "TARGET"
            elif price <= pos.signal.stop_price:
                reason = "STOP"
        else:
            if price <= pos.signal.target_price:
                reason = "TARGET"
            elif price >= pos.signal.stop_price:
                reason = "STOP"
        if reason is None and datetime.now(timezone.utc) >= pos.exit_deadline:
            reason = "TIMEOUT"
        if reason:
            announce_exit(pos, price, reason)
            log_exit(pos, price, reason)
            pos.status = reason.lower()


def scan_loop() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    log.info("options_signals starting — watching %d symbols: %s",
             len(WATCHLIST), ", ".join(WATCHLIST))
    log.info("market hours only: 09:30–16:00 ET, Mon–Fri")
    log.info("alerts → console + %s (signals), %s (exits)",
             SIGNAL_LOG.name, EXIT_LOG.name)

    positions: list[ActivePosition] = []
    last_fired: dict[str, datetime] = {}

    while True:
        now_et = datetime.now(MARKET_TZ)
        if not in_market_hours(now_et):
            update_positions(positions)
            log.info("outside market hours (%s ET) — sleeping 5min",
                     now_et.strftime("%a %H:%M"))
            time.sleep(300)
            continue

        for symbol in WATCHLIST:
            last = last_fired.get(symbol)
            if last and (datetime.now(timezone.utc) - last).total_seconds() < DEDUPE_MINUTES * 60:
                continue
            sig = score_symbol(symbol)
            if sig is not None:
                announce_signal(sig, now_et)
                log_signal(sig)
                last_fired[symbol] = sig.ts
                positions.append(ActivePosition(
                    signal=sig,
                    exit_deadline=datetime.now(timezone.utc) + timedelta(minutes=MAX_HOLD_MINUTES),
                ))
            time.sleep(PER_SYMBOL_DELAY_SEC)

        update_positions(positions)
        time.sleep(SCAN_INTERVAL_SEC)


if __name__ == "__main__":
    try:
        scan_loop()
    except KeyboardInterrupt:
        print("\nStopped.")
