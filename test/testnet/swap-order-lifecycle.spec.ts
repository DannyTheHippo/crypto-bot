/**
 * B3 deliverable 2 — Binance USD-M swap (binanceusdm) Demo Trading smoke test. ENV-GATED: connects
 * to a REAL venue, so it skips unless BINANCE_DEMO_API_KEY/SECRET are present — `pnpm test:testnet`
 * passes (all-skipped, --passWithNoTests) in CI, and exercises the real demo-fapi.binance.com
 * endpoint only at the out-of-session RUN. Constructed exactly as buildCcxtExchange's demo branch
 * does (ccxt-stream.adapter.ts:71-101), so a green RUN here validates the same code path a future
 * swap-live composition root would use.
 *
 * DEMO ONLY — no testnet fallback: order-lifecycle.spec.ts's spot suite auto-detects
 * BINANCE_TESTNET_* as a fallback sandbox, but Binance's USD-M swap testnet
 * (testnet.binancefuture.com) is a SEPARATE facility requiring its own key pair, out of scope here.
 * This spec self-skips on BINANCE_DEMO_* absence only.
 *
 * NOT verified in this environment without live demo credentials. Treat a first RUN as integration
 * discovery: confirm symbol filters, precision/limits shape, and the LIMIT_MAKER acceptance verdict.
 */
import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import type { Exchange } from 'ccxt';
import { buildCcxtExchange } from '../../src/features/trading/market-data/ccxt-stream.adapter';
import { resolveVenueUrls } from '../../src/features/trading/market-data/venue-urls';
import { assertSwapPrivateUrlSafe } from '../../src/shared/venue-safety/swap-url-guard';

const API_KEY = process.env['BINANCE_DEMO_API_KEY'] ?? '';
const API_SECRET = process.env['BINANCE_DEMO_API_SECRET'] ?? '';
const HAS_CREDS = Boolean(API_KEY && API_SECRET);
const SYM = 'BTC/USDT:USDT';

// Mirrors buildCcxtExchange's demo branch (ccxt-stream.adapter.ts:95-96: enableDemoTrading(true),
// number: String already applied by buildCcxtExchange itself) plus adjustForTimeDifference — demo
// trading keys are real-account keys checked against server time; without this a laggy local clock
// can get signed requests rejected as stale.
function buildSwapExchange(): Exchange {
  const exchange = buildCcxtExchange({ id: 'binanceusdm', environment: 'demo' });
  exchange.apiKey = API_KEY;
  exchange.secret = API_SECRET;
  (exchange as unknown as { options: Record<string, unknown> }).options['adjustForTimeDifference'] =
    true;
  return exchange;
}

// Public-only handle (no keys) against the LIVE fapi host, for the demo-vs-live divergence check.
// buildCcxtExchange's 'live' branch applies no sandbox/demo modification, so its resolved base URL
// is the real fapi.binance.com — never used for anything beyond a public fetchMarkPrice call below.
function buildLivePublicExchange(): Exchange {
  return buildCcxtExchange({ id: 'binanceusdm', environment: 'live' });
}

function markPriceOf(ticker: { markPrice?: number | null; last?: number | null }): Decimal {
  const raw = ticker.markPrice ?? ticker.last;
  if (raw === null || raw === undefined) {
    throw new Error('fetchMarkPrice returned neither markPrice nor last');
  }
  return new Decimal(raw);
}

// Minimal qty that clears BOTH venue filters — the lot-size minimum (limits.amount.min) AND the
// MIN_NOTIONAL filter (limits.cost.min, observed 50 USDT on binanceusdm demo — not exposed by
// limits.amount.min alone, which a first RUN discovered the hard way: -4164 "Order's notional must
// be no smaller than 50"). Rounds UP to the lot step via Decimal (never exchange.amountToPrecision,
// whose rounding mode may truncate toward zero and undercut the notional floor after rounding — a
// first RUN with only a 2% buffer still undershot 50 by ~0.4 USDT once truncated to the 0.0001 lot
// step); a 5% buffer plus explicit ceil-to-step guarantees the final qty clears both filters.
function minOrderQty(exchange: Exchange, symbol: string, limitPrice: Decimal): string {
  const market = exchange.market(symbol);
  const minAmount = new Decimal(market.limits.amount?.min ?? 0);
  const minNotional = new Decimal(market.limits.cost?.min ?? 0);
  const step = new Decimal(market.precision.amount ?? '0.00000001');
  const notionalFloorQty = minNotional.gt(0)
    ? minNotional.div(limitPrice).times('1.05')
    : new Decimal(0);
  const target = Decimal.max(minAmount, notionalFloorQty);
  return target.div(step).ceil().times(step).toFixed();
}

describe.skipIf(!HAS_CREDS)('Binance USD-M swap (binanceusdm) Demo Trading lifecycle', () => {
  it('0. resolves the private fapi base URL to demo-fapi.binance.com BEFORE any order call (fail-closed)', () => {
    const exchange = buildSwapExchange();
    const urls = resolveVenueUrls(exchange, 'binanceusdm');

    expect(new URL(urls.restSwapPrivate).hostname).toBe('demo-fapi.binance.com');
    expect(() => assertSwapPrivateUrlSafe(urls.restSwapPrivate, 'demo')).not.toThrow();
  });

  it('1. mark price, deep-OTM resting LIMIT buy at venue-minimum qty, fetchOpenOrders sees it, cancel', async () => {
    const exchange = buildSwapExchange();
    // Fail-closed, repeated at the call site (test 0 already proves this passes for this exchange
    // instance — belt-and-suspenders immediately before the first order call).
    assertSwapPrivateUrlSafe(resolveVenueUrls(exchange, 'binanceusdm').restSwapPrivate, 'demo');

    await exchange.loadMarkets();
    const ticker = await exchange.fetchMarkPrice(SYM);
    const mark = markPriceOf(ticker);

    // 30% below mark: well outside Binance's PERCENT_PRICE_BY_SIDE band, rests without filling.
    const rawLimitPrice = mark.times('0.7').toFixed();
    const limitPrice = exchange.priceToPrecision(SYM, rawLimitPrice);
    const qty = minOrderQty(exchange, SYM, new Decimal(limitPrice));

    const order = await exchange.createOrder(SYM, 'limit', 'buy', Number(qty), Number(limitPrice), {
      timeInForce: 'GTC',
    });
    expect(order.id).toBeTruthy();
    expect(order.status).not.toBe('closed'); // deep OTM — must rest, never immediately fill

    const openOrders = await exchange.fetchOpenOrders(SYM);
    expect(openOrders.some((o) => o.id === order.id)).toBe(true);

    const cancelled = await exchange.cancelOrder(order.id, SYM);
    expect(['canceled', 'closed']).toContain(cancelled.status);
    const openAfterCancel = await exchange.fetchOpenOrders(SYM);
    expect(openAfterCancel.some((o) => o.id === order.id)).toBe(false);
  }, 20_000);

  it('2. LIMIT_MAKER-style order (ccxt type "limit", params.postOnly=true, NO timeInForce) is ACCEPTED by the venue (no -1106) — verifies the D1 ENTRY_ORDER_TYPE knob precondition on the swap lane', async () => {
    const exchange = buildSwapExchange();
    assertSwapPrivateUrlSafe(resolveVenueUrls(exchange, 'binanceusdm').restSwapPrivate, 'demo');

    await exchange.loadMarkets();
    const ticker = await exchange.fetchMarkPrice(SYM);
    const mark = markPriceOf(ticker);

    const rawLimitPrice = mark.times('0.7').toFixed();
    const limitPrice = exchange.priceToPrecision(SYM, rawLimitPrice);
    const qty = minOrderQty(exchange, SYM, new Decimal(limitPrice));

    // Mirrors ccxt-exchange.adapter.ts's LIMIT_MAKER branch exactly: ccxt type 'limit', postOnly in
    // params, and DELIBERATELY no timeInForce key at all (Binance rejects the combination with
    // -1106 "Parameter 'timeInForce' sent when not required" if both are present).
    let accepted = false;
    let order: Awaited<ReturnType<typeof exchange.createOrder>> | undefined;
    try {
      order = await exchange.createOrder(SYM, 'limit', 'buy', Number(qty), Number(limitPrice), {
        postOnly: true,
      });
      accepted = true;
    } catch (err) {
      // Left in place (not caught-and-passed) so a real -1106 fails the test loudly with the venue's
      // own error text, rather than silently reporting a false acceptance.
      throw new Error(
        `LIMIT_MAKER-style order (limit + postOnly, no timeInForce) was REJECTED by the venue: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      if (order) await exchange.cancelOrder(order.id, SYM);
    }

    // Explicit, named verdict — this is the D1 knob's precondition being verified live.
    expect(accepted, 'LIMIT_MAKER acceptance verdict').toBe(true);
  }, 20_000);

  it('3. demo mark price diverges <1% from the public LIVE fapi mark price (demo mirrors live data)', async () => {
    const demo = buildSwapExchange();
    const live = buildLivePublicExchange(); // public fetchMarkPrice only, no keys ever set

    const demoMark = markPriceOf(await demo.fetchMarkPrice(SYM));
    const liveMark = markPriceOf(await live.fetchMarkPrice(SYM));

    const divergence = demoMark.minus(liveMark).abs().div(liveMark);
    // A large divergence means demo trading has drifted from live data — per the runbook, demo is
    // plumbing-only (order-path validation), never a PnL/pricing source; fail loudly rather than
    // silently trusting stale/desynced demo prices.
    expect(
      divergence.toNumber(),
      `demo mark ${demoMark.toFixed()} vs live mark ${liveMark.toFixed()} diverges ${divergence.times(100).toFixed(4)}% — demo is expected to mirror live data (plumbing-only, per the runbook)`,
    ).toBeLessThan(0.01);
  });
});
