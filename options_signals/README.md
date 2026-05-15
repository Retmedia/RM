# options_signals — intraday options trade-idea bot

Scans a watchlist of high-liquidity US equities during market hours,
fires `BUY CALL` / `BUY PUT` alerts when a defined intraday setup
triggers, suggests an ATM strike on the nearest weekly expiry, then
tracks the underlying and tells you when to exit — target hit, stop
hit, or a hard **2-hour** timeout.

**It does not place orders.** Output goes to your terminal and two
CSV files (`signals.csv`, `exits.csv`). You manually act on the
alerts in whatever broker you use.

## Setups it fires on

1. **Gap + VWAP** — open gapped > 1%, price is on the correct side of
   VWAP, and extrapolated daily volume is ≥ 1.5× the 20-day average.
2. **Opening-range breakout** — after the first 15 minutes, price
   closes outside the 9:30–9:45 high/low with volume support.

Each fired signal includes:

- Suggested option direction (CALL / PUT)
- Suggested expiry (nearest weekly with ≥ 2 DTE — avoids 0DTE assignment
  risk and the worst of theta)
- Suggested ATM strike, with current bid / ask / implied vol if the
  chain is available
- A stop at -0.5% on the underlying and a target at +1.0% on the
  underlying
- A forced 2-hour exit time printed in your console

## Reality check before you run this

Read this once.

- **Underlying moving in your direction ≠ your option printing.** Short-dated
  options bleed theta intraday and get crushed by an IV drop after the move.
  A "successful" 2-hour underlying move may still close the option at break-
  even or a loss.
- **The setups are heuristics, not predictions.** Hit-rate on intraday gap
  and ORB plays at retail is usually 40–55% before fees. Risk/reward and
  position sizing carry the strategy, not the signal.
- **Slippage on options is huge.** The bid-ask spread on a 3-DTE ATM call
  on a liquid name is often 2–5% of premium; on a less liquid name it can
  be 10%+. Always check the spread before clicking.
- **Paper trade first.** Run this for at least 2–4 weeks during market
  hours and look at `exits.csv`. If the underlying-PnL column doesn't
  trend positive over dozens of signals, the live PnL after option
  decay and spread will be worse.

## Install

```
cd options_signals
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Python 3.10+ (uses `zoneinfo`).

## Run

```
python bot.py
```

It will:

- Idle and sleep outside market hours (US/Eastern, weekdays)
- Scan every `SCAN_INTERVAL_SEC` during market hours
- Skip re-firing the same symbol within `DEDUPE_MINUTES`
- Update active positions on every scan and alert when one should exit

Stop with Ctrl+C.

## Configuration

All knobs are at the top of `bot.py`:

| Setting | Default | What it does |
| --- | --- | --- |
| `WATCHLIST` | SPY, QQQ, AAPL, NVDA, TSLA, AMD, META, MSFT, AMZN, GOOG | Symbols scanned each loop |
| `SCAN_INTERVAL_SEC` | 60 | Seconds between full watchlist scans |
| `DEDUPE_MINUTES` | 30 | Don't re-fire the same symbol within this window |
| `MIN_GAP_PCT` | 1.0 | Minimum opening gap to trigger gap setup |
| `MIN_REL_VOL` | 1.5 | Minimum relative volume vs 20-day average |
| `ORB_MINUTES` | 15 | Opening range window for ORB setup |
| `MAX_HOLD_MINUTES` | 120 | **2-hour forced exit** |
| `STOP_PCT` | 0.5 | Underlying %-move against you to stop |
| `TARGET_PCT` | 1.0 | Underlying %-move in your favor to take profit |

## Files

- `bot.py` — single-file scanner + position tracker
- `requirements.txt` — `yfinance`, `pandas`, `numpy`
- `signals.csv` — appended every time a signal fires
- `exits.csv` — appended every time a position exits
