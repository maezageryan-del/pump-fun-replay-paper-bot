[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/maezageryan-del/pump-fun-replay-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/maezageryan-del/pump-fun-replay-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Breakout Rider — Pump.fun Replay Paper Bot

A disciplined paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
on make.fun. It trades 10 SOL of paper money over a 24-hour replay of recorded
pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Measured on the kit's dev tape (1,222 mints, 126,801 trades), the median coin
ends 14.4% below its first trade price, dip-buying loses money at every
horizon, and only fast momentum pays. So the bot trades rarely, only into
confirmed breakouts, and lets the rare runners run:

- **Enter:** a coin's price is up at least 90% over its last 10 trades, sits
  within 3% of its 10-trade high, and holds at least 3 SOL of real reserve.
  Target 0.05 SOL per coin, built in per-batch buys capped at 1% of the coin's
  real reserve, adding only while the price holds at or above the entry price.
  The bar sits high on purpose: measured with the kit's own grader, a +30%
  bar scores −2.36 SOL on the dev window, +50% scores −0.87, +80% −0.26 and
  +90% −0.09 — a lower bar only adds losing trades.
- **Exit** the whole position on the first of: a hard stop of −8% vs cost
  (net of fees), a trailing stop of −15% from the position's peak value, or
  300 trades held. There is no fixed take-profit — winners stay open.
- **Portfolio:** at most 5 open positions, at most 16 orders per reply, every
  buy at least 0.01 SOL.
- **Fees:** a round trip costs ~1.25% of stake per side plus 105,000 lamports
  of transaction fees per order, so the 8% stop and 15% trail sit far above
  the ~2.5% round-trip cost.

Measured with the kit's own grader (`grade-local --driver process`) on the
dev window: **−0.087 SOL** net PnL, 31 distinct coins traded (guardrail: 20),
31 round trips, 35.5% win rate, 1.43% max drawdown, 90% interval
−0.30…+0.13 SOL. An early offline backtest had looked far better (+2.91 SOL)
because it filled orders at the signal price; the real grader fills two
slots later, and that latency costs the whole paper edge — the honest number
is the grader's, and it is reported here as measured. The dev window is one
historical day and the final 24 hours hold different coins, so no number
here is a promise about the final window: the claim is a selective,
capital-protecting bot whose 90% interval reaches above zero, with a small
drawdown and a wide guardrail margin.

## How it runs

`main.ts` speaks the `agent-fun/replay/v2` protocol on stdin/stdout (a hello
line, then one batch of events per slot, one reply of orders per batch) via
the vendored SDK shim in `vendor/makefun-bot.ts`. It needs no dependencies,
no network and no secrets, and runs as `node main.ts` on Node 22. Every
decision is a pure function of the hello line and the batches seen so far,
with exact bigint price math — no clock, no environment, no randomness — so
the two graded runs produce byte-identical action logs.

## Files

- `main.ts` — the bot (entrypoint, run as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim, unchanged
- `README.md` — this file
- `LICENSE` — MIT
- `.makefun/owner.json` — the payout wallet for the entry
