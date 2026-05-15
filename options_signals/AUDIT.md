# options_signals — audit & roadmap

End goal as I understand it: **fire one successful options trade per day**,
buy and sell intraday, no overnight risk. Below is an honest review of
what's in `bot.py` today, what's weak, and the order I'd improve it.

## What's already good

- Single-file, no broker dependency, console + CSV output
- CLI flags so you can tune without editing code
- Same-day exit logic: target, stop, trailing stop, EOD cutoff, hold cap
- "No new entries within 30min of EOD" rule prevents bag-holding into close
- Limit-price suggestions (mid ± 25% of spread) so you don't cross full ask
- Estimated option-PnL column in `exits.csv` based on a delta + theta SAW

## Weaknesses, in order of how much they hurt the end goal

### 1. yfinance data is good enough to develop on, not to trade on

`yfinance` scrapes Yahoo's public quotes. They're typically delayed
10–20 minutes on some symbols and the 1-minute bars sometimes back-fill
late. For an intraday alerter that's a fatal lag — by the time the bot
sees an ORB break it may already be 15 minutes stale.

**Fix:** swap to a real-time feed. Cheapest options in order:

- **Tradier sandbox** — free, real-time IEX-quality quotes if you have a
  brokerage account with them, REST + WebSocket
- **Polygon.io Starter** — $29/mo, real-time WS for stocks and options
  chains
- **Webull / IBKR Pro** — real-time via their API if you already trade there
- **Alpaca** — free real-time IEX feed, paid SIP feed

This is the single highest-leverage change. Until then, treat anything
the bot says about price as "true ~10 minutes ago".

### 2. The signal set is too simple to have edge on its own

Two setups (gap+VWAP, ORB break) on volume confirmation. These are
well-known and front-run by faster systems. Hit-rate at retail on a
1-min timeframe is typically 40–55% before fees. To matter you'd want:

- **Multi-timeframe confirmation:** require the 5-min trend to agree
  with the 1-min trigger
- **Regime filter:** skip setups when VIX is spiking — IV crush after
  the move kills calls/puts both ways
- **Pre-market context:** check overnight news / earnings flag for the
  symbol; gap-from-earnings has very different distribution than
  gap-from-flow
- **Relative-strength filter for longs:** SPY must be green to buy
  calls; SPY must be red to buy puts (sector tailwind/headwind)

### 3. Position management treats the option like a contract for the underlying

The bot's target/stop are on the **underlying**, then a separate function
guesses the option's PnL using `delta = 0.50` and a fixed-rate theta.
For 0–3 DTE ATM options that approximation degrades as the underlying
moves (gamma shifts delta) and as IV reprices.

**Fix path:** start tracking the actual option's bid/ask every cycle
(re-poll the chain after the entry) and trigger exits on **premium**
PnL, not just underlying. The current `est_option_pnl_pct` column in
`exits.csv` will tell you how badly the underlying-only stops/targets
correlate with the real option P&L over time.

### 4. No backtest, no walk-forward

Right now you have to wait days of market hours to see if the strategy
even has hit-rate. That's slow and biased — your first week could be
all losers and you'd kill the strategy that actually works.

**Fix:** add `bot.py --backtest --since 2026-04-01 --until 2026-05-01`
that replays daily+1m bars from yfinance/polygon through the same
`score_symbol` and same exit logic, and prints win-rate, avg-win,
avg-loss, expectancy, and max drawdown. This is the next thing I'd
build.

### 5. Slippage and fees aren't modeled in exits.csv

The `est_option_pnl_pct` column ignores:
- Bid/ask spread crossing (typically eats 2–5% of premium round-trip on
  liquid weeklies, 10%+ on illiquid)
- Per-contract commissions (~$0.65/contract at most brokers, none at
  Robinhood/Webull)
- Regulatory fees (small but real)

**Fix:** add `--fees-per-contract`, `--slippage-bps` flags and apply
them in `estimate_option_pnl_pct`. Then the column reflects realistic
take-home.

### 6. ATM ATM only — no edge selection on the chain

Picking the strike nearest the underlying is the simplest thing but not
the smartest. For a directional intraday play you usually want one of:

- **OTM weekly (~0.30 delta)** — cheaper, more bang per dollar, but
  more theta and IV-crush risk
- **ITM weekly (~0.70 delta)** — pricier, lower IV sensitivity, behaves
  more like a leveraged share trade

Which is right depends on the setup's expected magnitude and time. A
gap-and-go has a big-move tail → OTM has better expected value. An
ORB-fade-then-reclaim is a small move → ITM is safer.

### 7. No IV-rank filter

Buying a call when its IV is in the 95th percentile of its 30-day range
is paying retail to be wrong. The bot does not check this.

**Fix:** before firing, compare current option IV to a 30-day history
(the chain returns IV daily; cache it) and skip / warn if IV percentile
is too high.

### 8. Notification channels limited to terminal + CSV

If you're not staring at the console you'll miss signals and exits.

**Fix path (easy):**
- Desktop bell on `>>> EXIT` lines
- Optional Discord webhook (one HTTP POST, ~10 lines)
- Optional ntfy.sh push to your phone

### 9. No persistence of open positions across restart

If you Ctrl+C with a position open, on restart the bot has no idea
there's a live trade — your broker still has it but the bot stops
tracking. Acceptable for an alerter (you'd see it in the broker) but
worth a `positions.json` checkpoint eventually.

### 10. Time zone handling assumes the system clock is correct

If you run this on a server in another tz the conversion is fine because
we use `zoneinfo`, but there's no NTP / drift check. Not a real risk on
a laptop, would matter on a VPS.

## What I'd build next, in order

1. **Backtest mode** (#4). One day's work. Without it, every other
   change is a guess. This is the highest-ROI thing left.
2. **Switch data source to a real-time feed** (#1). Half a day if you
   already have a Tradier or Alpaca account.
3. **Premium-based exit instead of underlying-based** (#3). Re-poll the
   option's bid/ask in `update_position` and exit on premium PnL targets.
4. **Fees + slippage in PnL** (#5). 30 minutes. Makes the CSV honest.
5. **IV-rank filter and OTM/ITM selection knob** (#6, #7). Half a day.
6. **Discord/ntfy notifications** (#8). 20 minutes.

After step 1 you will know whether the strategy is worth shipping. If
it's not, the rest is wasted work — that's the point of doing #4 first.

## What I would not bother with

- ML / neural-net "signal models" on top of OHLCV — overfits, slow,
  no edge over the basic setups at retail timeframes
- Auto-execution to your broker — manual is fine for one trade a day
  and removes a whole category of bugs (wrong size, wrong leg, runaway loop)
- Pattern recognition on candle shapes — folklore, doesn't survive
  walk-forward
