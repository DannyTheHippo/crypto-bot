/**
 * Phase 7 — Binance Spot Testnet order-path scenarios (§9 matrix). ENV-GATED: these connect to a
 * REAL venue, so they skip unless BINANCE_TESTNET_API_KEY/SECRET are present — `pnpm test:testnet`
 * passes (all-skipped) in CI, and exercises the real CcxtExchangeAdapter only at the out-of-session
 * RUN. The adapter is constructed exactly as the composition root does (buildCcxtExchange + apiKey
 * + RealCcxtOrderClient), so a green RUN here validates the same code path production uses.
 *
 * NOT verified in this environment (no credentials). Treat a first RUN as integration discovery:
 * confirm symbol filters, monthly-reset tolerance, and the apiRestrictions response shape.
 */
import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { buildCcxtExchange } from '../../src/features/venue/market-data/ccxt-stream.adapter';
import { RealCcxtOrderClient } from '../../src/features/venue/exchange/ccxt-order-client';
import { CcxtExchangeAdapter } from '../../src/features/venue/exchange/ccxt-exchange.adapter';
import { AdapterError } from '../../src/ports/venue/exchange';
import {
  intentId,
  encodeClientOrderId,
  venueId,
  symbolId,
  epochMs,
} from '../../src/domain/common/types/ids';
import { uuidv7 } from '../../src/features/trading/risk/uuidv7';
import { randomBytes } from 'node:crypto';

// Sandbox flavor (design §3.5 / SANDBOX_ENV): prefer Binance Demo Trading (enableDemoTrading —
// live-mirroring market data, real-account keys, the pre-live dress rehearsal) when its keys are
// present, else the Spot Testnet (setSandboxMode — purpose-built integration sandbox). Neither key
// pair set ⇒ the whole suite skips, so `pnpm test:testnet` stays all-skipped (green) in CI and runs
// against the configured sandbox only at the out-of-session RUN.
const DEMO = Boolean(process.env['BINANCE_DEMO_API_KEY'] && process.env['BINANCE_DEMO_API_SECRET']);
const TESTNET = Boolean(
  process.env['BINANCE_TESTNET_API_KEY'] && process.env['BINANCE_TESTNET_API_SECRET'],
);
const HAS_CREDS = DEMO || TESTNET;
const ENVIRONMENT: 'demo' | 'testnet' = DEMO ? 'demo' : 'testnet';
const API_KEY =
  (DEMO ? process.env['BINANCE_DEMO_API_KEY'] : process.env['BINANCE_TESTNET_API_KEY']) ?? '';
const API_SECRET =
  (DEMO ? process.env['BINANCE_DEMO_API_SECRET'] : process.env['BINANCE_TESTNET_API_SECRET']) ?? '';
const SYM = symbolId('BTC/USDT');
const VEN = venueId('binance');

function buildExchange() {
  const exchange = buildCcxtExchange({ id: 'binance', environment: ENVIRONMENT });
  exchange.apiKey = API_KEY;
  exchange.secret = API_SECRET;
  return exchange;
}
function adapter(): CcxtExchangeAdapter {
  return new CcxtExchangeAdapter(new RealCcxtOrderClient(buildExchange()), VEN, true);
}
// clientOrderId carries the sandbox mode char 't' in both flavors — these are sandbox orders, not live.
const coid = () =>
  encodeClientOrderId(intentId(uuidv7(epochMs(Date.now()), randomBytes(10))), 'testnet');

describe.skipIf(!HAS_CREDS)(
  `Binance ${DEMO ? 'Demo Trading' : 'Spot Testnet'} order lifecycle`,
  () => {
    it('1. validateCredentials succeeds with withdrawals disabled', async () => {
      const cc = await adapter().validateCredentials();
      expect(cc.valid).toBe(true);
      expect(cc.withdrawalsEnabled).toBe(false); // §10c — withdrawals MUST be disabled
    });

    it('2. fetchBalances returns exact-string asset balances', async () => {
      const balances = await adapter().fetchBalances();
      expect(balances.size).toBeGreaterThan(0);
      for (const [, b] of balances) {
        expect(typeof b.free).toBe('string');
        expect(typeof b.locked).toBe('string');
      }
    });

    it('3. place a far-from-market passive limit, fetchOrder by clientOrderId, then cancel', async () => {
      // Share one exchange handle: the live price (for a filter-valid bid) and the adapter under
      // test read the same testnet market. A bid 30% below the live price rests without filling
      // yet stays inside Binance's PERCENT_PRICE_BY_SIDE band (bidMultiplierDown ~0.2 for BTC/USDT)
      // — a hardcoded $1000 bid on a ~$100k asset trips that filter (the adapter correctly surfaces
      // it as a TERMINAL_REJECT AdapterError; the order simply never rests).
      const exchange = buildExchange();
      const a = new CcxtExchangeAdapter(new RealCcxtOrderClient(exchange), VEN, true);
      const id = coid();

      const ticker = await exchange.fetchTicker('BTC/USDT');
      const ref = new Decimal(String(ticker.last ?? ticker.bid ?? ticker.close));
      const limitPrice = ref.times('0.7').toFixed(2); // tick-aligned (BTC/USDT tickSize 0.01)

      const ack = await a.placeOrder({
        clientOrderId: id,
        symbol: SYM,
        side: 'BUY',
        type: 'LIMIT',
        qty: '0.001',
        limitPrice,
        timeInForce: 'GTC',
        reduceOnly: false,
      });
      expect(ack.clientOrderId).toBe(id);
      expect(ack.venueOrderId).toBeTruthy();

      const state = await a.fetchOrder(id, SYM); // §6.2 lookup by clientOrderId
      expect(state.status).toBe('open');
      expect(state.clientOrderId).toBe(id);

      const cancel = await a.cancelOrder(id, SYM);
      expect(cancel.clientOrderId).toBe(id);
    }, 20_000);

    it('4. fetchOrder for an unknown clientOrderId raises an OUTCOME_AMBIGUOUS/TERMINAL AdapterError (never raw ccxt)', async () => {
      await expect(adapter().fetchOrder(coid(), SYM)).rejects.toBeInstanceOf(AdapterError);
    });

    it('5. an insufficient-balance order is refused as a TERMINAL_REJECT AdapterError', async () => {
      const a = adapter();
      await expect(
        a.placeOrder({
          clientOrderId: coid(),
          symbol: SYM,
          side: 'BUY',
          type: 'LIMIT',
          qty: '1000000',
          limitPrice: '1000000',
          timeInForce: 'GTC',
          reduceOnly: false,
        }),
      ).rejects.toMatchObject({ errorClass: 'TERMINAL_REJECT' });
    });

    it('6. fetchMyTrades returns exact-string fills with venue tradeIds', async () => {
      const fills = await adapter().fetchMyTrades(SYM, epochMs(Date.now() - 86_400_000));
      for (const f of fills) {
        expect(typeof f.price).toBe('string');
        expect(f.venueTradeId).toBeTruthy();
        expect(f.venue).toBe(VEN);
      }
    });
  },
);
