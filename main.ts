// Breakout Rider — a disciplined paper bot for the pump.fun replay sprint.
//
// Idea, measured on the kit's dev tape (1,222 mints, 126,801 trades): the median
// coin ends 14.4% below its first trade price, dip-buying has a negative median
// forward return at every horizon, and only fast momentum pays — after a +50%
// rise over 10 trades the median forward return turns positive. So this bot
// trades rarely and only into confirmed breakouts, then lets the rare runners
// run behind a trailing stop instead of capping them with a take-profit.
//
// Rules:
//   - Enter: price up >= 90% over the coin's last 10 trades, within 3% of its
//     10-trade high, real SOL reserve >= 3 SOL. Target 0.05 SOL per coin, built
//     in per-batch buys capped at 1% of real reserve (the harness cap), adding
//     only while the price holds at or above the first entry price.
//   - Exit the whole position on the first of: hard stop -8% vs cost (net of
//     fees), trailing stop -15% from the position's peak value, or 300 trades
//     held. No fixed take-profit.
//   - Portfolio: at most 5 open positions, at most 16 orders in one reply,
//     every buy at least 0.01 SOL (the guardrail's minimum round trip).
//   - Fees: a round trip costs ~1.25% of stake per side plus 105,000 lamports
//     of tx fees per order (about 0.42% of a 0.05 SOL stake), so the 8% stop
//     and 15% trail sit far above the ~2.9% round-trip cost; a stopped trade
//     loses about 8%, a winner is open.
//
// The hello line carries the capital, caps, fees and latency. Each batch
// carries one slot of events plus the fills and account since the last batch,
// and the bot answers that batch with its orders for that slot. Orders decided
// on a slot fill two slots later. Deterministic by construction: every decision
// is a pure function of the hello line and the batches seen so far, iterated
// in insertion order, with exact bigint price math — no clock, no environment,
// no randomness — so the two graded runs produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// --- tunables (all measured with the kit's own grade-local on the dev
// --- window, 22 configs swept: a lower rise bar only adds losing trades
// --- (+30% scores -2.36 SOL, +50% -0.87, +80% -0.26, +90% -0.13 at the
// --- same stake), a tighter stop helps a little, and a wider trail hurts,
// --- so the bar sits high and the stop sits tight) --------------------------
const LOOKBACK_TRADES = 10; // rise is measured over this many trades
const MIN_RISE_NUM = 19n; // price now >= 1.9x the price LOOKBACK trades ago
const MIN_RISE_DEN = 10n;
const NEAR_HIGH_NUM = 97n; // price now >= 97% of the lookback window's high
const NEAR_HIGH_DEN = 100n;
const MIN_REAL_SOL = 3n * LAMPORTS_PER_SOL; // coin must hold this much real SOL
const TARGET_STAKE = 5n * LAMPORTS_PER_SOL / 100n; // 0.05 SOL per coin
const MIN_BUY = LAMPORTS_PER_SOL / 100n; // 0.01 SOL, the guardrail minimum
const STOP_LOSS_BPS = 800; // -8% vs cost, net of fees
const TRAIL_BPS = 1500; // -15% from the position's peak value
const MAX_HOLD_TRADES = 300; // time exit, counted in the coin's trades
const SLIPPAGE_BPS = 10_000; // never miss an entry or an exit over slippage

// Price as an exact fraction: virtual SOL reserves over virtual token reserves.
interface Price {
  vs: bigint;
  vt: bigint;
}

// Per-coin tape kept by the bot itself: the last LOOKBACK+1 trade prices, the
// trade count at the first buy decision, that entry price, and the peak gross
// value of the open position (lamports).
interface CoinTape {
  prices: Price[];
  entryTrades: number | null;
  entryPrice: Price | null;
  peakValue: bigint;
}

const tapes = new Map<Pubkey, CoinTape>();

function tapeFor(mint: Pubkey): CoinTape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = { prices: [], entryTrades: null, entryPrice: null, peakValue: 0n };
    tapes.set(mint, tape);
  }
  return tape;
}

// priceNow / priceThen >= num / den, with exact bigint cross-multiplication.
function riseAtLeast(now: Price, then: Price, num: bigint, den: bigint): boolean {
  return now.vs * then.vt * den >= then.vs * now.vt * num;
}

// Gross value of `tokens` at `price`, in lamports (floored bigint division).
function valueLamports(tokens: bigint, price: Price): bigint {
  if (price.vt === 0n) return 0n;
  return (tokens * price.vs) / price.vt;
}

// Net SOL received when selling `tokens` at `price`: curve fees off the gross
// value, then one order's tx fees off the result.
function sellProceeds(state: BotState, tokens: bigint, price: Price): bigint {
  const gross = valueLamports(tokens, price);
  const feeBps = BigInt(
    state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback,
  );
  const afterCurveFees = gross - (gross * feeBps) / 10_000n;
  const net = afterCurveFees - state.txFeeLamports();
  return net > 0n ? net : 0n;
}

// SOL already committed to a coin: the held position's cost plus any buy
// orders still in flight for it.
function investedLamports(state: BotState, mint: Pubkey): bigint {
  let invested = 0n;
  const held = state.positions.get(mint);
  if (held !== undefined) invested += held.cost_lamports;
  for (const pending of state.pending.values()) {
    if (pending.order.mint === mint && pending.order.side === 'buy') {
      invested += BigInt(pending.order.quote_lamports) + state.txFeeLamports();
    }
  }
  return invested;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.mint === mint && pending.order.side === 'sell') return true;
  }
  return false;
}

function priceNow(state: BotState, mint: Pubkey): Price | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return {
    vs: curve.virtual_quote_reserves,
    vt: curve.virtual_token_reserves,
  };
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    // Cash the bot itself has promised in this batch's reply so far. The
    // state's free-cash figure only knows about orders already in flight,
    // not the orders pushed to this reply, so track the reply's own spend
    // locally or several buys in one batch could over-commit the account.
    let free = state.freeCashLamports();

    // Fold this batch's trades into each coin's tape first, so entries and
    // exits below both see the freshest prices.
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      const tape = tapeFor(event.mint);
      tape.prices.push({
        vs: BigInt(event.virtual_sol_reserves),
        vt: BigInt(event.virtual_token_reserves),
      });
      if (tape.prices.length > LOOKBACK_TRADES + 1) tape.prices.shift();
    }

    // --- exits: whole-position sells, first trigger wins -------------------
    for (const [mint, held] of state.positions) {
      if (hasPendingSell(state, mint)) continue;
      const price = priceNow(state, mint);
      if (price === null) continue;
      const tape = tapes.get(mint);
      const value = valueLamports(held.token_amount, price);
      const peak = tape !== undefined ? tape.peakValue : 0n;
      const newPeak = value > peak ? value : peak;
      if (tape !== undefined) tape.peakValue = newPeak;
      const proceeds = sellProceeds(state, held.token_amount, price);
      const retBps = ((proceeds - held.cost_lamports) * 10_000n) / held.cost_lamports;
      const heldTrades =
        tape !== undefined && tape.entryTrades !== null
          ? (state.curves.get(mint)?.trades ?? 0) - tape.entryTrades
          : 0;
      const stopHit = retBps <= -BigInt(STOP_LOSS_BPS);
      const trailHit = newPeak > 0n && value * 10_000n <= newPeak * BigInt(10_000 - TRAIL_BPS);
      const staleHit = heldTrades >= MAX_HOLD_TRADES;
      if (stopHit || trailHit || staleHit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: held.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        if (tape !== undefined) {
          tape.entryTrades = null;
          tape.entryPrice = null;
          tape.peakValue = 0n;
        }
      }
      if (orders.length >= maxOrders) return orders;
    }

    // --- entries and adds: one decision per coin in this batch -------------
    const seenThisBatch = new Set<Pubkey>();
    for (const event of batch.events) {
      if (orders.length >= maxOrders) break;
      if (event.event !== 'TradeEvent' && event.event !== 'CreateEvent') continue;
      const mint = event.mint;
      if (seenThisBatch.has(mint)) continue;
      seenThisBatch.add(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      const tape = tapes.get(mint);
      if (tape === undefined || tape.prices.length < LOOKBACK_TRADES + 1) continue;
      const now = tape.prices[tape.prices.length - 1];
      const then = tape.prices[0];
      if (!riseAtLeast(now, then, MIN_RISE_NUM, MIN_RISE_DEN)) continue;
      // Price must sit within 3% of its lookback-window high: a breakout
      // still near its high, not a rise that already faded.
      let nearHigh = true;
      for (const past of tape.prices) {
        if (!riseAtLeast(now, past, NEAR_HIGH_NUM, NEAR_HIGH_DEN)) {
          nearHigh = false;
          break;
        }
      }
      if (!nearHigh) continue;
      const held = state.positions.get(mint);
      const invested = investedLamports(state, mint);
      if (invested >= TARGET_STAKE) continue;
      // A buy decided earlier that never filled (rejected or failed) leaves
      // stale entry markers behind; clear them so a fresh signal starts clean.
      const buyInFlight = [...state.pending.values()].some(
        (p) => p.order.mint === mint && p.order.side === 'buy',
      );
      if (held === undefined && !buyInFlight && tape.entryTrades !== null) {
        tape.entryTrades = null;
        tape.entryPrice = null;
        tape.peakValue = 0n;
      }
      if (held === undefined) {
        // A new coin needs a free position slot.
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      } else {
        // An add only pyramids into strength: at or above the entry price.
        const entry = tape.entryPrice;
        if (entry !== null && !riseAtLeast(now, entry, 1n, 1n)) continue;
      }
      const cap = state.maxBuyLamports(mint);
      let amount = TARGET_STAKE - invested;
      if (amount > cap) amount = cap;
      const affordable = free - txFee;
      if (amount > affordable) amount = affordable;
      if (amount < MIN_BUY) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      if (held === undefined && tape.entryTrades === null) {
        tape.entryTrades = curve.trades;
        tape.entryPrice = now;
        tape.peakValue = 0n;
      }
    }

    return orders;
  },
});
