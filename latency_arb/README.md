# latency_arb — paper-trading sandbox

A read-only, paper-trading sandbox for the "latency arbitrage on prediction
markets" idea that goes viral every few months. It connects to:

- **Binance** public trade WebSocket (`wss://stream.binance.com:9443/ws/<symbol>@trade`)
  as the *fast* signal feed
- **Polymarket** public Gamma + CLOB REST APIs as the *slow* target market

When the strategy thinks Polymarket's implied probability on a short-duration
BTC market lags the Binance spot move, it logs a **simulated** buy at the
current best ask, applies a configurable fee + slippage, and tracks the
position to a configurable exit. **No real orders are ever placed.** No
account, key, or wallet is required to run it.

## What this is for

To answer one question honestly, with your own data, before risking a dollar:

> Does this strategy have positive expected value for me, after realistic
> fees and slippage, given my latency from my laptop to these venues?

The viral "$0.90 → $408k" story is marketing. Real latency arb edges are
small, decay fast, and are dominated by colocated firms. The honest path is:
run this for days, look at the trade log, and only consider live capital if
the simulated PnL is consistently and meaningfully positive after realistic
costs. It almost certainly won't be — that's a useful answer too.

## Install

```
cd latency_arb
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Python 3.10+.

## Run

```
python bot.py
```

By default it scans Polymarket's active markets for ones whose question
mentions "Bitcoin" and resolves within `MAX_HOURS_TO_RESOLUTION` hours, and
trades the first `MAX_MARKETS` of them in paper mode.

Stop with Ctrl+C. A summary prints on shutdown and trades are appended to
`trades.csv`.

## Configuration

Edit the `Config` block at the top of `bot.py`:

| Setting | Meaning |
| --- | --- |
| `BINANCE_SYMBOL` | Spot symbol for the fast feed, e.g. `btcusdt` |
| `MOMENTUM_WINDOW_SEC` | How far back to look for the BTC move that drives the signal |
| `EDGE_THRESHOLD` | How big the gap between model prob and market prob has to be to "trade" |
| `FEE_BPS` | Per-side fee in basis points applied to simulated fills |
| `SLIPPAGE_BPS` | Per-side slippage in basis points |
| `HOLD_SECONDS` | How long to hold before forcing exit |
| `MAX_POSITION_USD` | Notional per simulated trade |
| `MAX_HOURS_TO_RESOLUTION` | Skip markets that resolve further out than this |
| `MAX_MARKETS` | Cap concurrent markets watched |
| `POLL_INTERVAL_SEC` | Polymarket REST poll cadence (well under their public limits) |

## What it does NOT do

- Place real orders anywhere
- Use your Webull / Kalshi / Polymarket / Gemini account
- Predict the market reliably
- Make you money

## Files

- `bot.py` — single-file event loop, feeds, strategy, paper engine, logging
- `requirements.txt` — `aiohttp`, `websockets`
- `trades.csv` — appended on every simulated entry/exit (created on first run)
