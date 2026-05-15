# options_signals — intraday options trade-idea bot

Scans a watchlist of high-liquidity US equities during market hours,
fires `BUY CALL` / `BUY PUT` alerts when a defined intraday setup
triggers, suggests an ATM strike on a near-dated weekly expiry with a
limit-price recommendation, then tracks the underlying and tells you
when to exit:

- target hit
- stop hit
- trailing stop hit (after underlying moves halfway to target)
- end-of-day cutoff (default 15:55 ET)
- hard hold cap (default 180 min)

**It does not place orders.** Output goes to your terminal and two CSV
files (`signals.csv`, `exits.csv`). You manually act on the alerts in
whatever broker you use.

> Read `AUDIT.md` before you trust it with money. The honest summary:
> yfinance data is delayed enough to hurt intraday edge, the signal set
> is intentionally simple, and there's no backtest yet — so use the
> bot to *learn* the workflow first, then improve it (see the audit
> for the order I'd improve it in).

## Quickstart

```bash
./run.sh
```

That's it. On first launch `run.sh` creates a venv in `.venv/`,
installs requirements, and starts the scanner. Subsequent runs reuse
the venv. Stop with Ctrl+C.

If you'd rather manage the venv yourself:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python bot.py
```

Python 3.10+ (uses `zoneinfo`).

## CLI flags

Pass any of these through `run.sh` or `python bot.py`:

```
./run.sh --help
./run.sh --watchlist SPY,QQQ,NVDA --stop-pct 0.4 --target-pct 0.8
./run.sh --max-hold-minutes 240 --eod-cutoff 15:50
./run.sh --min-gap-pct 1.5 --min-rel-vol 2.0
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--watchlist` | 10 mega-caps | Comma-separated tickers |
| `--scan-interval` | 60 | Seconds between full watchlist scans |
| `--dedupe-minutes` | 30 | Don't re-fire the same symbol in this window |
| `--min-gap-pct` | 1.0 | Opening gap % required for the gap setup |
| `--min-rel-vol` | 1.5 | Extrapolated daily volume vs 20d average |
| `--stop-pct` | 0.5 | Underlying %-move adverse to stop |
| `--target-pct` | 1.0 | Underlying %-move favorable to take profit |
| `--max-hold-minutes` | 180 | Hard hold cap |
| `--eod-cutoff` | `15:55` | ET force-exit time |
| `--trail-activate` | 0.5 | Fraction of target distance that arms the trail |
| `--trail-lock` | 0.5 | Fraction of current gain locked by the trail |
| `--quiet` / `--debug` | — | Log verbosity |

## Setups it fires on

1. **Gap + VWAP** — open gapped > `--min-gap-pct`, price is on the
   correct side of VWAP, extrapolated daily volume ≥ `--min-rel-vol` ×
   the 20-day average, and intraday RSI isn't already exhausted.
2. **Opening-range breakout** — after the first 15 minutes, price
   closes outside the 9:30–9:45 high/low with volume support.

Each fired signal includes:

- Direction (CALL / PUT)
- Suggested expiry (nearest weekly with ≥ 2 DTE — avoids 0DTE
  assignment risk and the worst of theta)
- Suggested ATM strike with current bid / ask / IV from the chain
- **Suggested BUY LIMIT** (mid + 25% of spread) and **SELL LIMIT** (mid
  − 25% of spread) so you don't cross the full ask/bid
- Stop and target on the underlying
- Forced EOD and hold-cap exit times

## Same-day exit logic

When a position is open the scanner re-checks the underlying on every
loop and closes on whichever fires first:

| Reason | Condition |
| --- | --- |
| `TARGET` | Underlying moves `--target-pct` in your favor |
| `STOP` | Underlying moves `--stop-pct` against you |
| `TRAIL` | After underlying passes halfway to target, a trailing stop locks in 50% of the gain; you exit if that level is hit |
| `EOD` | Clock passes `--eod-cutoff` ET (default 15:55) — no overnight |
| `TIMEOUT` | Hold time exceeds `--max-hold-minutes` |

New signals are suppressed once you're within ~30 minutes of the EOD
cutoff — the position wouldn't have time to play out anyway.

## Output

- **Console** — banner per signal, line per exit
- **`signals.csv`** — every signal fired (ts, symbol, direction, setup,
  score, entry, stop, target, strike, expiry, bid, ask, iv, buy_limit,
  sell_limit)
- **`exits.csv`** — every position closed (ts, symbol, direction,
  reason, entry, exit, underlying_pnl_pct, est_option_pnl_pct,
  hold_minutes)

The `est_option_pnl_pct` column uses a crude `delta=0.5` + IV-derived
theta model. See `AUDIT.md` § 3 for the limits of that approximation.

## Reality check

Read this once.

- **Underlying moving in your direction ≠ your option printing.**
  Theta + IV-crush after the move can take a "successful" underlying
  play to break-even or a small loss. The exits are the bot's
  discipline, not its edge.
- **Slippage on options is huge.** Bid-ask on a 3-DTE ATM call on a
  liquid name is typically 2–5% of premium; on a less liquid name it
  can be 10%+. The buy/sell limits help but don't eliminate it.
- **Hit-rate on these setups at retail is 40–55%.** Position sizing
  and the stop carry the strategy, not the signal.
- **Paper trade for 2–4 weeks** during market hours and look at
  `exits.csv` before you put a real ticket through your broker.

## Files

- `run.sh` — first-run venv bootstrap + launcher
- `bot.py` — single-file scanner, position tracker, CLI
- `requirements.txt` — `yfinance`, `pandas`, `numpy`
- `AUDIT.md` — honest review and improvement roadmap
- `signals.csv`, `exits.csv` — created on first signal / first exit
