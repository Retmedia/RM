"""Paper-trading sandbox for prediction-market latency arb.

Single file on purpose. Read top-to-bottom.

Data sources (both public, no auth):
  - Binance trade WebSocket   wss://stream.binance.com:9443/ws/<symbol>@trade
  - Polymarket Gamma REST     https://gamma-api.polymarket.com/markets
  - Polymarket CLOB REST      https://clob.polymarket.com/{book,midpoint,price}

Fills are simulated. No orders are sent anywhere.
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import math
import signal
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import websockets


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

BINANCE_SYMBOL = "btcusdt"
BINANCE_WS_URL = f"wss://stream.binance.com:9443/ws/{BINANCE_SYMBOL}@trade"

GAMMA_URL = "https://gamma-api.polymarket.com/markets"
CLOB_BOOK_URL = "https://clob.polymarket.com/book"
CLOB_MIDPOINT_URL = "https://clob.polymarket.com/midpoint"

MOMENTUM_WINDOW_SEC = 60          # rolling window of BTC ticks
EDGE_THRESHOLD = 0.08             # required gap between model prob and market prob
FEE_BPS = 10                      # per-side fee (basis points of notional)
SLIPPAGE_BPS = 50                 # per-side slippage (basis points of notional)
HOLD_SECONDS = 300                # forced exit after N seconds in position
MAX_POSITION_USD = 100.0          # paper notional per trade
MAX_HOURS_TO_RESOLUTION = 48      # only watch markets resolving soon
MAX_MARKETS = 5                   # concurrent markets watched
POLL_INTERVAL_SEC = 3.0           # per-market poll cadence (Polymarket REST)
MARKET_KEYWORDS = ("bitcoin", "btc")

TRADE_LOG = Path(__file__).with_name("trades.csv")

log = logging.getLogger("latency_arb")


# --------------------------------------------------------------------------
# Fast feed: rolling Binance price window
# --------------------------------------------------------------------------

@dataclass
class PriceTape:
    """Rolling (timestamp, price) tape for the fast feed."""
    window_sec: float
    ticks: deque = field(default_factory=deque)

    def add(self, price: float, ts: float) -> None:
        self.ticks.append((ts, price))
        cutoff = ts - self.window_sec
        while self.ticks and self.ticks[0][0] < cutoff:
            self.ticks.popleft()

    def last(self) -> float | None:
        return self.ticks[-1][1] if self.ticks else None

    def oldest(self) -> float | None:
        return self.ticks[0][1] if self.ticks else None

    def momentum_pct(self) -> float | None:
        """Pct change across the window. None if not enough data."""
        if len(self.ticks) < 2:
            return None
        old = self.ticks[0][1]
        new = self.ticks[-1][1]
        if old == 0:
            return None
        return (new - old) / old


async def binance_feed(tape: PriceTape, stop: asyncio.Event) -> None:
    """Subscribe to Binance trade stream and append to tape forever."""
    backoff = 1.0
    while not stop.is_set():
        try:
            async with websockets.connect(BINANCE_WS_URL, ping_interval=15) as ws:
                log.info("binance ws connected")
                backoff = 1.0
                async for raw in ws:
                    if stop.is_set():
                        break
                    msg = json.loads(raw)
                    price = float(msg["p"])
                    tape.add(price, time.time())
        except Exception as e:
            log.warning("binance ws error: %s — reconnecting in %.1fs", e, backoff)
            try:
                await asyncio.wait_for(stop.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, 30.0)


# --------------------------------------------------------------------------
# Slow target: Polymarket public REST
# --------------------------------------------------------------------------

async def discover_markets(http: aiohttp.ClientSession) -> list[dict]:
    """Return short-dated markets whose question mentions our keywords.

    Polymarket markets have one or more outcome tokens; for binary markets
    there are two (typically Yes/No), each with a token id in `clobTokenIds`.
    We trade the 'Yes' side (index 0) by convention.
    """
    params = {"closed": "false", "active": "true", "limit": 200}
    async with http.get(GAMMA_URL, params=params, timeout=10) as r:
        r.raise_for_status()
        raw = await r.json()

    now = datetime.now(timezone.utc)
    out: list[dict] = []
    for m in raw:
        q = (m.get("question") or "").lower()
        if not any(k in q for k in MARKET_KEYWORDS):
            continue
        end_iso = m.get("endDate") or m.get("end_date_iso")
        if not end_iso:
            continue
        try:
            end_dt = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
        except ValueError:
            continue
        hours = (end_dt - now).total_seconds() / 3600
        if hours <= 0 or hours > MAX_HOURS_TO_RESOLUTION:
            continue

        token_ids_raw = m.get("clobTokenIds")
        if isinstance(token_ids_raw, str):
            try:
                token_ids = json.loads(token_ids_raw)
            except json.JSONDecodeError:
                continue
        else:
            token_ids = token_ids_raw or []
        if not token_ids:
            continue

        out.append({
            "question": m["question"],
            "slug": m.get("slug"),
            "end_dt": end_dt,
            "yes_token_id": token_ids[0],
        })
        if len(out) >= MAX_MARKETS:
            break
    return out


async def midpoint(http: aiohttp.ClientSession, token_id: str) -> float | None:
    try:
        async with http.get(CLOB_MIDPOINT_URL, params={"token_id": token_id}, timeout=5) as r:
            if r.status != 200:
                return None
            data = await r.json()
            return float(data["mid"])
    except (aiohttp.ClientError, asyncio.TimeoutError, KeyError, ValueError):
        return None


async def best_ask(http: aiohttp.ClientSession, token_id: str) -> float | None:
    try:
        async with http.get(CLOB_BOOK_URL, params={"token_id": token_id}, timeout=5) as r:
            if r.status != 200:
                return None
            data = await r.json()
            asks = data.get("asks") or []
            if not asks:
                return None
            # CLOB returns asks sorted ascending; best ask is index 0
            return float(asks[0]["price"])
    except (aiohttp.ClientError, asyncio.TimeoutError, KeyError, ValueError, IndexError):
        return None


# --------------------------------------------------------------------------
# Strategy: turn BTC momentum into a probability estimate
# --------------------------------------------------------------------------

def model_probability(momentum_pct: float, hours_to_resolution: float) -> float:
    """Crude logistic on momentum, scaled by time-to-resolution.

    The closer to resolution, the more a sharp move should pull the implied
    probability. Far-dated markets barely move on a tick.

    This is intentionally simple. The point of paper trading is to find out
    whether even a naive signal has edge before you bother with a smarter one.
    """
    if hours_to_resolution <= 0:
        return 0.5
    decay = math.exp(-hours_to_resolution / 6.0)   # ~6h half-life
    z = momentum_pct * 200.0 * decay               # 200 = sensitivity knob
    return 1.0 / (1.0 + math.exp(-z))


# --------------------------------------------------------------------------
# Paper engine
# --------------------------------------------------------------------------

@dataclass
class Position:
    market_slug: str
    token_id: str
    entry_price: float
    entry_ts: float
    notional_usd: float
    model_prob_at_entry: float

    def shares(self) -> float:
        return self.notional_usd / self.entry_price


@dataclass
class Book:
    cash: float = 10_000.0
    realized_pnl: float = 0.0
    trades: int = 0
    wins: int = 0


def fee_and_slip(notional: float) -> float:
    return notional * (FEE_BPS + SLIPPAGE_BPS) / 10_000.0


def log_trade(row: dict) -> None:
    new = not TRADE_LOG.exists()
    with TRADE_LOG.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(row.keys()))
        if new:
            w.writeheader()
        w.writerow(row)


def open_position(book: Book, mkt: dict, ask: float, model_prob: float) -> Position | None:
    cost = MAX_POSITION_USD + fee_and_slip(MAX_POSITION_USD)
    if book.cash < cost:
        log.warning("not enough paper cash to open: have %.2f need %.2f", book.cash, cost)
        return None
    book.cash -= cost
    pos = Position(
        market_slug=mkt["slug"] or mkt["yes_token_id"][:8],
        token_id=mkt["yes_token_id"],
        entry_price=ask,
        entry_ts=time.time(),
        notional_usd=MAX_POSITION_USD,
        model_prob_at_entry=model_prob,
    )
    log.info(
        "OPEN  %-40s ask=%.3f model_p=%.3f notional=$%.0f cash=$%.2f",
        pos.market_slug[:40], ask, model_prob, pos.notional_usd, book.cash,
    )
    log_trade({
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "event": "open",
        "market": pos.market_slug,
        "token_id": pos.token_id,
        "price": ask,
        "model_prob": round(model_prob, 4),
        "notional_usd": pos.notional_usd,
        "fee_slip_usd": round(fee_and_slip(MAX_POSITION_USD), 4),
        "cash_after": round(book.cash, 2),
        "pnl_usd": "",
    })
    return pos


def close_position(book: Book, pos: Position, exit_price: float, reason: str) -> None:
    proceeds = pos.shares() * exit_price
    cost = fee_and_slip(proceeds)
    net = proceeds - cost
    pnl = net - pos.notional_usd
    book.cash += net
    book.realized_pnl += pnl
    book.trades += 1
    if pnl > 0:
        book.wins += 1
    log.info(
        "CLOSE %-40s exit=%.3f pnl=%+7.2f cash=$%.2f reason=%s",
        pos.market_slug[:40], exit_price, pnl, book.cash, reason,
    )
    log_trade({
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "event": f"close:{reason}",
        "market": pos.market_slug,
        "token_id": pos.token_id,
        "price": exit_price,
        "model_prob": "",
        "notional_usd": pos.notional_usd,
        "fee_slip_usd": round(cost, 4),
        "cash_after": round(book.cash, 2),
        "pnl_usd": round(pnl, 4),
    })


# --------------------------------------------------------------------------
# Per-market loop
# --------------------------------------------------------------------------

async def trade_market(
    http: aiohttp.ClientSession,
    tape: PriceTape,
    book: Book,
    mkt: dict,
    stop: asyncio.Event,
) -> None:
    position: Position | None = None
    log.info("watching: %s (resolves %s)", mkt["question"], mkt["end_dt"].isoformat())

    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL_SEC)
            break
        except asyncio.TimeoutError:
            pass

        momentum = tape.momentum_pct()
        if momentum is None:
            continue

        hours_left = (mkt["end_dt"] - datetime.now(timezone.utc)).total_seconds() / 3600
        if hours_left <= 0:
            if position:
                last_mid = await midpoint(http, mkt["token_id"]) or position.entry_price
                close_position(book, position, last_mid, "expired")
                position = None
            return

        model_p = model_probability(momentum, hours_left)
        mid = await midpoint(http, mkt["token_id"])
        if mid is None:
            continue

        if position is None:
            if model_p - mid > EDGE_THRESHOLD:
                ask = await best_ask(http, mkt["token_id"])
                if ask is not None and model_p - ask > EDGE_THRESHOLD:
                    position = open_position(book, mkt, ask, model_p)
        else:
            age = time.time() - position.entry_ts
            reached_target = mid >= position.model_prob_at_entry
            timed_out = age >= HOLD_SECONDS
            reversed_signal = model_p < mid - EDGE_THRESHOLD / 2
            if reached_target or timed_out or reversed_signal:
                reason = (
                    "target" if reached_target
                    else "timeout" if timed_out
                    else "reversed"
                )
                close_position(book, position, mid, reason)
                position = None


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    tape = PriceTape(window_sec=MOMENTUM_WINDOW_SEC)
    book = Book()
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    async with aiohttp.ClientSession() as http:
        markets = await discover_markets(http)
        if not markets:
            log.error(
                "no eligible markets found on Polymarket "
                "(keywords=%s, max_hours=%d). Adjust MARKET_KEYWORDS or "
                "MAX_HOURS_TO_RESOLUTION and try again.",
                MARKET_KEYWORDS, MAX_HOURS_TO_RESOLUTION,
            )
            return

        for m in markets:
            log.info("market: %s — resolves in %.1fh",
                     m["question"], (m["end_dt"] - datetime.now(timezone.utc)).total_seconds() / 3600)

        tasks = [
            asyncio.create_task(binance_feed(tape, stop), name="binance"),
            *[
                asyncio.create_task(trade_market(http, tape, book, m, stop),
                                    name=f"mkt:{m['slug']}")
                for m in markets
            ],
        ]

        # Let the tape warm up before the per-market loops start trading.
        log.info("warming up fast feed for %ds...", MOMENTUM_WINDOW_SEC)

        await stop.wait()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    win_rate = (book.wins / book.trades * 100) if book.trades else 0.0
    log.info("=" * 60)
    log.info("SESSION SUMMARY")
    log.info("  trades:      %d", book.trades)
    log.info("  wins:        %d  (%.1f%%)", book.wins, win_rate)
    log.info("  realized:    $%+.2f", book.realized_pnl)
    log.info("  final cash:  $%.2f (starting $10,000.00)", book.cash)
    log.info("  trade log:   %s", TRADE_LOG)
    log.info("=" * 60)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
