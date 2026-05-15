"""Intraday equity-options signal bot with same-day exit logic.

Scans a watchlist of liquid US equities during market hours, fires
BUY CALL / BUY PUT alerts on defined intraday setups, suggests an ATM
strike on a near-dated expiry with a limit-price recommendation, then
tracks the underlying and an estimated option-premium PnL to alert you
when to exit. Exits trigger on whichever comes first:

  - target hit (underlying)
  - stop hit (underlying)
  - trailing stop hit (after underlying moves halfway to target)
  - end-of-day cutoff (default 15:55 ET)
  - hard hold cap (default 180 min)

This is an alerter. It does not place orders. You manually act on the
alerts in your broker. Output goes to console + CSV (signals.csv,
exits.csv).

Run during US market hours (Mon-Fri 09:30-16:00 ET). Outside those
hours it sleeps and prints why.
"""

from __future__ import annotations

import argparse
import csv
import logging
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf


# --------------------------------------------------------------------------
# Defaults (override via CLI flags — see parse_args())
# --------------------------------------------------------------------------

DEFAULT_WATCHLIST = "SPY,QQQ,AAPL,NVDA,TSLA,AMD,META,MSFT,AMZN,GOOG"

MARKET_TZ = ZoneInfo("America/New_York")
MARKET_OPEN = dtime(9, 30)
MARKET_CLOSE = dtime(16, 0)

# Filters used inside score_symbol — fixed, not user-tunable on the CLI
ORB_MINUTES = 15
RSI_OVERBOUGHT_GUARD = 78
RSI_OVERSOLD_GUARD = 22

log = logging.getLogger("options_signals")


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

@dataclass
class Config:
    watchlist: list[str]
    scan_interval_sec: int = 60
    per_symbol_delay_sec: float = 1.5
    dedupe_minutes: int = 30
    min_gap_pct: float = 1.0
    min_rel_vol: float = 1.5
    max_hold_minutes: int = 180
    stop_pct: float = 0.5
    target_pct: float = 1.0
    eod_cutoff: dtime = dtime(15, 55)
    trail_activate_pct_of_target: float = 0.5
    trail_lock_in_pct_of_gain: float = 0.5
    signal_log: Path = field(default_factory=lambda: Path(__file__).with_name("signals.csv"))
    exit_log: Path = field(default_factory=lambda: Path(__file__).with_name("exits.csv"))


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
    suggested_buy_limit: Optional[float] = None
    suggested_sell_limit: Optional[float] = None


@dataclass
class ActivePosition:
    signal: Signal
    exit_deadline: datetime
    trail_active: bool = False
    trail_stop_underlying: Optional[float] = None
    status: str = "open"    # "open", "target", "stop", "trail", "timeout", "eod"


# --------------------------------------------------------------------------
# Market hours
# --------------------------------------------------------------------------

def in_market_hours(now_et: datetime) -> bool:
    if now_et.weekday() >= 5:
        return False
    return MARKET_OPEN <= now_et.time() <= MARKET_CLOSE


def past_eod_cutoff(now_et: datetime, cutoff: dtime) -> bool:
    return now_et.weekday() < 5 and now_et.time() >= cutoff


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

def score_symbol(symbol: str, cfg: Config) -> Optional[Signal]:
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

    if abs(gap_pct) >= cfg.min_gap_pct and rel_vol >= cfg.min_rel_vol:
        if gap_pct > 0 and last > vwap and rsi < RSI_OVERBOUGHT_GUARD:
            setup, direction = "gap_up_vwap", "CALL"
            score = abs(gap_pct) + (rel_vol - 1) * 2
        elif gap_pct < 0 and last < vwap and rsi > RSI_OVERSOLD_GUARD:
            setup, direction = "gap_down_vwap", "PUT"
            score = abs(gap_pct) + (rel_vol - 1) * 2

    if setup is None and len(intraday) > ORB_MINUTES + 5:
        if last > orb_high * 1.001 and rel_vol >= cfg.min_rel_vol:
            setup, direction = "orb_break_up", "CALL"
            score = (last - orb_high) / orb_high * 100 + (rel_vol - 1)
        elif last < orb_low * 0.999 and rel_vol >= cfg.min_rel_vol:
            setup, direction = "orb_break_down", "PUT"
            score = (orb_low - last) / orb_low * 100 + (rel_vol - 1)

    if setup is None or direction is None:
        return None

    expiry, strike, bid, ask, iv = pick_option(ticker, last, direction)
    buy_lim, sell_lim = suggest_limits(bid, ask)

    if direction == "CALL":
        stop_price = last * (1 - cfg.stop_pct / 100)
        target_price = last * (1 + cfg.target_pct / 100)
    else:
        stop_price = last * (1 + cfg.stop_pct / 100)
        target_price = last * (1 - cfg.target_pct / 100)

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
        suggested_buy_limit=buy_lim,
        suggested_sell_limit=sell_lim,
    )


def pick_option(ticker, underlying_price: float, direction: str):
    """Nearest weekly expiry (>= 2 DTE), ATM strike. Any field may be None."""
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


def suggest_limits(bid: Optional[float], ask: Optional[float]):
    """Return (buy_limit, sell_limit) suggestions from the current spread.

    Buy: pay 25% into the spread above mid (likely to fill without crossing
    the full ask).
    Sell: ask 25% into the spread below mid (likely to fill without giving up
    the full bid). Symmetric. Quote prices to the nearest cent.
    """
    if bid is None or ask is None or ask <= bid or bid <= 0:
        return None, None
    mid = (bid + ask) / 2
    spread = ask - bid
    buy = round(mid + 0.25 * spread, 2)
    sell = round(mid - 0.25 * spread, 2)
    return buy, sell


# --------------------------------------------------------------------------
# Option PnL estimation
# --------------------------------------------------------------------------
# Without a real Greeks feed we approximate ATM weekly behavior:
#   delta_call  =  0.50
#   delta_put   = -0.50
#   theta/day estimate is derived from IV using a rough %-of-premium rule
# This is a SAW, not a microscope. Use it for "are we still vaguely on
# track?" not "what's my exact P&L?".

ATM_DELTA = 0.50


def estimate_option_pnl_pct(
    sig: Signal,
    current_underlying: float,
    minutes_elapsed: float,
) -> Optional[float]:
    if sig.option_bid is None or sig.option_ask is None or sig.suggested_buy_limit is None:
        return None
    entry_premium = sig.suggested_buy_limit
    if entry_premium <= 0:
        return None

    delta = ATM_DELTA if sig.direction == "CALL" else -ATM_DELTA
    intrinsic_move = delta * (current_underlying - sig.entry_price)

    # Crude daily theta: 5% of premium per trading day for ATM weeklies.
    # Scale to minutes elapsed out of ~390 minutes in a session.
    theta_per_min = 0.05 * entry_premium / 390.0
    theta_drag = theta_per_min * minutes_elapsed

    est_exit_premium = entry_premium + intrinsic_move - theta_drag
    return (est_exit_premium - entry_premium) / entry_premium * 100


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------

SIGNAL_FIELDS = [
    "ts", "symbol", "direction", "setup", "score",
    "entry", "stop", "target",
    "expiry", "strike", "bid", "ask", "iv",
    "buy_limit", "sell_limit",
]
EXIT_FIELDS = [
    "ts", "symbol", "direction", "reason",
    "entry", "exit", "underlying_pnl_pct", "est_option_pnl_pct",
    "hold_minutes",
]


def append_csv(path: Path, fieldnames: list[str], row: dict) -> None:
    new = not path.exists()
    with path.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        if new:
            w.writeheader()
        w.writerow(row)


def log_signal(cfg: Config, s: Signal) -> None:
    append_csv(cfg.signal_log, SIGNAL_FIELDS, {
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
        "buy_limit": s.suggested_buy_limit if s.suggested_buy_limit is not None else "",
        "sell_limit": s.suggested_sell_limit if s.suggested_sell_limit is not None else "",
    })


def log_exit(cfg: Config, pos: ActivePosition, exit_price: float, reason: str,
             est_option_pnl_pct: Optional[float]) -> None:
    sign = 1 if pos.signal.direction == "CALL" else -1
    pnl_pct = sign * (exit_price - pos.signal.entry_price) / pos.signal.entry_price * 100
    hold_min = (datetime.now(timezone.utc) - pos.signal.ts).total_seconds() / 60
    append_csv(cfg.exit_log, EXIT_FIELDS, {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "symbol": pos.signal.symbol,
        "direction": pos.signal.direction,
        "reason": reason,
        "entry": round(pos.signal.entry_price, 2),
        "exit": round(exit_price, 2),
        "underlying_pnl_pct": round(pnl_pct, 3),
        "est_option_pnl_pct": round(est_option_pnl_pct, 2) if est_option_pnl_pct is not None else "",
        "hold_minutes": round(hold_min, 1),
    })


# --------------------------------------------------------------------------
# Pretty printing
# --------------------------------------------------------------------------

def announce_signal(s: Signal, cfg: Config, now_et: datetime) -> None:
    exit_at = (now_et + timedelta(minutes=cfg.max_hold_minutes)).strftime("%H:%M")
    eod = cfg.eod_cutoff.strftime("%H:%M")
    log.info("")
    log.info("=" * 70)
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
        if s.suggested_buy_limit is not None:
            log.info("  BUY  LIMIT  $%.2f    (mid + 25%% of spread)", s.suggested_buy_limit)
        if s.suggested_sell_limit is not None:
            log.info("  SELL LIMIT  $%.2f    (mid - 25%% of spread, working target)",
                     s.suggested_sell_limit)
    else:
        log.info("  option chain unavailable — check broker for nearest weekly")
    log.info("  exits:     target / stop / trail-stop / %s ET hold-cap / %s ET EOD",
             exit_at, eod)
    log.info("=" * 70)
    log.info("")


def announce_exit(pos: ActivePosition, price: float, reason: str,
                  est_option_pnl_pct: Optional[float]) -> None:
    sign = 1 if pos.signal.direction == "CALL" else -1
    move = sign * (price - pos.signal.entry_price) / pos.signal.entry_price * 100
    pnl_str = ""
    if est_option_pnl_pct is not None:
        pnl_str = f"  est_option_pnl={est_option_pnl_pct:+.1f}%"
    log.info("")
    log.info(">>> EXIT  %s %s  @ %.2f   %s   underlying=%+.2f%%%s",
             pos.signal.symbol, pos.signal.direction, price, reason, move, pnl_str)
    log.info("")


# --------------------------------------------------------------------------
# Position lifecycle
# --------------------------------------------------------------------------

def get_last_price(symbol: str) -> Optional[float]:
    try:
        bars = yf.Ticker(symbol).history(period="1d", interval="1m")
        if bars.empty:
            return None
        return float(bars["Close"].iloc[-1])
    except Exception:
        return None


def update_position(cfg: Config, pos: ActivePosition, now_et: datetime) -> bool:
    """Check one open position; close it if any exit condition fires.

    Returns True if the position was closed.
    """
    if pos.status != "open":
        return False
    price = get_last_price(pos.signal.symbol)
    if price is None:
        return False

    now_utc = datetime.now(timezone.utc)
    minutes_elapsed = (now_utc - pos.signal.ts).total_seconds() / 60
    sig = pos.signal

    # Trailing stop: once we're halfway to target, lock in part of the gain
    halfway = sig.entry_price + (sig.target_price - sig.entry_price) * cfg.trail_activate_pct_of_target
    if sig.direction == "CALL":
        if price >= halfway and not pos.trail_active:
            pos.trail_active = True
            lock = sig.entry_price + (price - sig.entry_price) * cfg.trail_lock_in_pct_of_gain
            pos.trail_stop_underlying = max(sig.entry_price, lock)
            log.info("trail armed for %s: stop raised to %.2f",
                     sig.symbol, pos.trail_stop_underlying)
        elif pos.trail_active:
            new_stop = sig.entry_price + (price - sig.entry_price) * cfg.trail_lock_in_pct_of_gain
            if new_stop > (pos.trail_stop_underlying or 0):
                pos.trail_stop_underlying = new_stop
    else:  # PUT
        if price <= halfway and not pos.trail_active:
            pos.trail_active = True
            lock = sig.entry_price + (price - sig.entry_price) * cfg.trail_lock_in_pct_of_gain
            pos.trail_stop_underlying = min(sig.entry_price, lock)
            log.info("trail armed for %s: stop lowered to %.2f",
                     sig.symbol, pos.trail_stop_underlying)
        elif pos.trail_active:
            new_stop = sig.entry_price + (price - sig.entry_price) * cfg.trail_lock_in_pct_of_gain
            if new_stop < (pos.trail_stop_underlying or 1e18):
                pos.trail_stop_underlying = new_stop

    reason: Optional[str] = None
    if sig.direction == "CALL":
        if price >= sig.target_price:
            reason = "TARGET"
        elif price <= sig.stop_price:
            reason = "STOP"
        elif pos.trail_active and pos.trail_stop_underlying is not None \
                and price <= pos.trail_stop_underlying:
            reason = "TRAIL"
    else:
        if price <= sig.target_price:
            reason = "TARGET"
        elif price >= sig.stop_price:
            reason = "STOP"
        elif pos.trail_active and pos.trail_stop_underlying is not None \
                and price >= pos.trail_stop_underlying:
            reason = "TRAIL"

    if reason is None and past_eod_cutoff(now_et, cfg.eod_cutoff):
        reason = "EOD"
    if reason is None and now_utc >= pos.exit_deadline:
        reason = "TIMEOUT"

    if reason:
        est_pnl = estimate_option_pnl_pct(sig, price, minutes_elapsed)
        announce_exit(pos, price, reason, est_pnl)
        log_exit(cfg, pos, price, reason, est_pnl)
        pos.status = reason.lower()
        return True
    return False


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

def scan_loop(cfg: Config) -> None:
    log.info("options_signals starting")
    log.info("  watchlist:  %s", ", ".join(cfg.watchlist))
    log.info("  scan every: %ds       dedupe: %dmin", cfg.scan_interval_sec, cfg.dedupe_minutes)
    log.info("  stop:       %.2f%%    target: %.2f%%", cfg.stop_pct, cfg.target_pct)
    log.info("  max hold:   %dmin     EOD cutoff: %s ET",
             cfg.max_hold_minutes, cfg.eod_cutoff.strftime("%H:%M"))
    log.info("  trail:      arms at %.0f%% of target, locks %.0f%% of gain",
             cfg.trail_activate_pct_of_target * 100, cfg.trail_lock_in_pct_of_gain * 100)
    log.info("  logs:       %s   %s", cfg.signal_log.name, cfg.exit_log.name)

    positions: list[ActivePosition] = []
    last_fired: dict[str, datetime] = {}

    while True:
        now_et = datetime.now(MARKET_TZ)

        # Always update any open positions, even right before/after close —
        # an EOD exit can fire during after-hours-but-still-Thursday.
        for pos in positions:
            update_position(cfg, pos, now_et)

        if not in_market_hours(now_et):
            log.info("outside market hours (%s ET) — sleeping 5min",
                     now_et.strftime("%a %H:%M"))
            time.sleep(300)
            continue

        # Don't open new positions in the last hold-window minutes — wouldn't
        # have time to play out before EOD.
        cutoff_dt = datetime.combine(now_et.date(), cfg.eod_cutoff, tzinfo=MARKET_TZ)
        minutes_left = (cutoff_dt - now_et).total_seconds() / 60
        accept_new = minutes_left > 30

        if accept_new:
            for symbol in cfg.watchlist:
                last = last_fired.get(symbol)
                if last and (datetime.now(timezone.utc) - last).total_seconds() < cfg.dedupe_minutes * 60:
                    continue
                sig = score_symbol(symbol, cfg)
                if sig is not None:
                    announce_signal(sig, cfg, now_et)
                    log_signal(cfg, sig)
                    last_fired[symbol] = sig.ts
                    positions.append(ActivePosition(
                        signal=sig,
                        exit_deadline=datetime.now(timezone.utc) + timedelta(minutes=cfg.max_hold_minutes),
                    ))
                time.sleep(cfg.per_symbol_delay_sec)
        else:
            log.info("within %.0fmin of EOD cutoff — no new signals, tracking only",
                     minutes_left)

        time.sleep(cfg.scan_interval_sec)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_args(argv: list[str]) -> Config:
    p = argparse.ArgumentParser(
        prog="options_signals",
        description="Intraday options signal alerter with same-day exit logic.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--watchlist", default=DEFAULT_WATCHLIST,
                   help="Comma-separated tickers to scan.")
    p.add_argument("--scan-interval", type=int, default=60,
                   help="Seconds between full watchlist scans.")
    p.add_argument("--dedupe-minutes", type=int, default=30,
                   help="Don't re-fire the same symbol within this window.")
    p.add_argument("--min-gap-pct", type=float, default=1.0,
                   help="Opening gap %% required for the gap+vwap setup.")
    p.add_argument("--min-rel-vol", type=float, default=1.5,
                   help="Extrapolated daily volume vs 20d average.")
    p.add_argument("--stop-pct", type=float, default=0.5,
                   help="Underlying %% adverse move that triggers the stop.")
    p.add_argument("--target-pct", type=float, default=1.0,
                   help="Underlying %% favorable move that triggers the target.")
    p.add_argument("--max-hold-minutes", type=int, default=180,
                   help="Hard hold cap (regardless of EOD).")
    p.add_argument("--eod-cutoff", default="15:55",
                   help="ET time-of-day to force-exit any open position.")
    p.add_argument("--trail-activate", type=float, default=0.5,
                   help="Fraction of the target distance that arms the trailing stop.")
    p.add_argument("--trail-lock", type=float, default=0.5,
                   help="Fraction of current gain locked in by the trailing stop.")
    p.add_argument("--quiet", action="store_true",
                   help="Reduce logging verbosity (WARN+ only).")
    p.add_argument("--debug", action="store_true",
                   help="Show debug-level messages.")
    args = p.parse_args(argv)

    if args.debug:
        level = logging.DEBUG
    elif args.quiet:
        level = logging.WARNING
    else:
        level = logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%H:%M:%S")

    try:
        hh, mm = args.eod_cutoff.split(":")
        eod = dtime(int(hh), int(mm))
    except ValueError:
        p.error(f"--eod-cutoff must be HH:MM, got {args.eod_cutoff!r}")

    watchlist = [t.strip().upper() for t in args.watchlist.split(",") if t.strip()]
    if not watchlist:
        p.error("--watchlist cannot be empty")

    return Config(
        watchlist=watchlist,
        scan_interval_sec=args.scan_interval,
        dedupe_minutes=args.dedupe_minutes,
        min_gap_pct=args.min_gap_pct,
        min_rel_vol=args.min_rel_vol,
        stop_pct=args.stop_pct,
        target_pct=args.target_pct,
        max_hold_minutes=args.max_hold_minutes,
        eod_cutoff=eod,
        trail_activate_pct_of_target=args.trail_activate,
        trail_lock_in_pct_of_gain=args.trail_lock,
    )


def main(argv: Optional[list[str]] = None) -> int:
    cfg = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        scan_loop(cfg)
    except KeyboardInterrupt:
        log.info("stopped by user")
    return 0


if __name__ == "__main__":
    sys.exit(main())
