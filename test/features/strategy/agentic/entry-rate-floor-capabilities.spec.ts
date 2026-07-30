// Regression cover for the 2026-07-30 capabilities defect.
//
// `replayPlanRow` built its capabilities object from CONSTANTS while the recorded row payload carried
// the real ones, so the replay contradicted its own input:
//
//   - `maxSizeFraction`: the caller's 0.25 was used as the zod bound against a payload advertising
//     0.35 on perp / 0.15 on spot. A model that believed its own payload and proposed 0.30 was
//     schema-rejected — abstention manufactured by the harness's inconsistency.
//   - `shorts`: enabled uniformly, so the 139 SPOT rows recorded `shorts: false` were replayed as if
//     the short side were available when live said otherwise.
//   - `leverage`: '2' on rows recorded at 1 or 5.
//   - `venueFreeCash: '0'` against a recorded $380-700. The first diagnosis blamed this one for the
//     under-entry and was wrong — the model reads free cash from the recorded payload either way.
//
// The under-entry itself is real and unexplained: on 33 identical rows live entered 6 times (18.2%)
// and the replay once (4.5%).
//
// Later that day the tool description stopped carrying ANY capability text (see buildTradeTool's own
// comment — one byte-identical tool, so it stops invalidating the prompt cache). The recorded row's
// own `capabilities` block, which rides in rowPayload verbatim, is now the sole channel telling the
// replayed model its shorts/leverage/maxSizeFraction — exactly as live — and `caps` binds only the
// zod schema. The assertions below moved from the tool to the payload with it.
//
// At the time, `replayPlanRow` was the shared call-builder for two MINT-TIME gates — the entry-rate
// floor (`measureEntryRate`) and the candidate expectancy backtest — so these mismatches reached
// production decisions about which playbooks may be minted, not just this study. Both gates went with
// the reflection loop later that day; the primitive's fidelity is still load-bearing for every
// replay-driven measurement, and nothing stops a future gate from calling it again.

import { describe, it, expect } from 'vitest';
import {
  recordedCapabilities,
  replayPlanRow,
  type PlanReplayCallConfig,
} from '../../../../src/features/strategy/agentic/entry-rate-floor';
import { PERP_VENUE_ID, SPOT_VENUE_ID } from '../../../../src/domain/venue/types/venue-map';

const PERP_CAPS = {
  venue: 'binanceusdm',
  shorts: true,
  leverage: '2',
  maxSizeFraction: '0.35',
  venueFreeCash: '500',
} as const;

const payload = (caps: unknown): string =>
  JSON.stringify({ symbol: 'BTC/USDT:USDT', interval: '15m', capabilities: caps, candles: [] });

function cfg(over: Partial<PlanReplayCallConfig> = {}): PlanReplayCallConfig {
  return {
    apiKey: 'k',
    model: 'test-model',
    timeoutMs: 5_000,
    // Deliberately NOT the recorded 0.35 — every test below turns on which of the two wins.
    sizeFractionMax: '0.25',
    shortsEnabled: false,
    ...over,
  };
}

/** Captures the outbound request so the tool description can be inspected. */
function captureFetch(toolInput: unknown): {
  fetchFn: typeof fetch;
  body: () => Record<string, unknown>;
} {
  let sent = '';
  const fetchFn = ((_url: string, init?: { body?: string }) => {
    sent = init?.body ?? '';
    return Promise.resolve(
      new Response(
        JSON.stringify({
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', name: 'submit_trade', input: toolInput }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, body: () => JSON.parse(sent) as Record<string, unknown> };
}

/**
 * The user-message text the model actually reads, concatenated. The row payload rides as a JSON
 * STRING inside the request body, so stringifying `messages` again would double-escape every quote
 * and make a `"shorts":false` match silently impossible.
 */
const userText = (body: Record<string, unknown>): string =>
  (body.messages as { content: { text: string }[] }[])
    .flatMap((m) => m.content.map((c) => c.text))
    .join('');

const openLong = (sizeFraction: number): Record<string, unknown> => ({
  action: 'open_long',
  sizeFraction,
  entry: { style: 'maker', offsetBps: 10 },
  entryValidityBars: 2,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  maxHoldBars: 3,
});

describe('recordedCapabilities', () => {
  it('extracts the capabilities the live system recorded on the row', () => {
    expect(recordedCapabilities(payload(PERP_CAPS))).toEqual({
      venue: PERP_VENUE_ID,
      shorts: true,
      leverage: '2',
      maxSizeFraction: '0.35',
      venueFreeCash: '500',
    });
  });

  it('resolves the spot venue too', () => {
    const caps = recordedCapabilities(
      payload({ ...PERP_CAPS, venue: 'binance', shorts: false, leverage: '1' }),
    );
    expect(caps?.venue).toBe(SPOT_VENUE_ID);
    expect(caps?.shorts).toBe(false);
  });

  it('returns undefined rather than force-branding an unmodelled venue', () => {
    // A replay against a venue this codebase does not model is not a faithful replay, so it falls back
    // to the config path instead of casting a string into the VenueId brand.
    expect(recordedCapabilities(payload({ ...PERP_CAPS, venue: 'kraken' }))).toBeUndefined();
  });

  it('returns undefined on a payload with no capabilities block, a partial one, or non-JSON', () => {
    expect(recordedCapabilities(JSON.stringify({ symbol: 'BTC/USDT' }))).toBeUndefined();
    // Partial is undefined, never silently completed from constants — that is the defect itself.
    expect(
      recordedCapabilities(
        payload({
          venue: PERP_CAPS.venue,
          shorts: PERP_CAPS.shorts,
          leverage: PERP_CAPS.leverage,
          maxSizeFraction: PERP_CAPS.maxSizeFraction,
        }),
      ),
    ).toBeUndefined();
    expect(recordedCapabilities('not json at all')).toBeUndefined();
    expect(recordedCapabilities('')).toBeUndefined();
  });
});

describe('replayPlanRow capability sourcing', () => {
  it('does NOT route venueFreeCash into the tool description — recorded so the claim is not re-derived', async () => {
    // Worth an explicit test because the first diagnosis of the 2026-07-30 under-entry blamed
    // `venueFreeCash: '0'` for telling the model it had no money, and THAT IS WRONG for this path:
    // the tool description carries no capability figure at all (2026-07-30 unification), and the only
    // free-cash figure the model sees in a replay is the true one already inside the recorded row
    // payload. The under-entry (18.2% live vs 4.5% replayed, same rows) is a measured fact whose
    // cause remains UNIDENTIFIED.
    const { fetchFn, body } = captureFetch(openLong(0.1));
    await replayPlanRow(cfg(), 'sys', 'pb', payload(PERP_CAPS), fetchFn);
    const tools = JSON.stringify((body() as { tools: unknown }).tools);
    expect(tools).not.toContain('venueFreeCash');
    expect(tools).not.toContain('free cash');
    // The recorded figure IS in the user message, which is the point: absent from the tool, present
    // in the payload. Asserted here so "not in the tool" can never be satisfied by it reaching the
    // model nowhere at all.
    expect(userText(body())).toContain('"venueFreeCash":"500"');
  });

  it('routes the RECORDED sizeFraction ceiling, leverage and shorts to the model via the payload capabilities block', async () => {
    // These are the capabilities that genuinely reach the model, so these are the ones the fix
    // actually corrects. The recorded row is leverage 5 / 0.35 against the caller's constant 2 /
    // 0.25, so the assertion distinguishes the two sources.
    //
    // 2026-07-30: the CHANNEL moved, the property did not. These figures used to be baked into the
    // tool description ("leverage is capped at 5x", "[0.005, 0.35]"); the tool is now byte-identical
    // for every symbol, so the recorded `capabilities` block in the row payload — which is what
    // `recordedCapabilities` parses, and which rides in `rowPayload` verbatim — is the sole channel.
    // Live works the same way (anthropic-agent-client.ts passes `capabilities: caps` on both the
    // single-symbol and batch paths unconditionally), so the replay still matches production.
    const { fetchFn, body } = captureFetch(openLong(0.1));
    await replayPlanRow(cfg(), 'sys', 'pb', payload({ ...PERP_CAPS, leverage: '5' }), fetchFn);
    const messages = userText(body());
    expect(messages).toContain('"leverage":"5"');
    expect(messages).toContain('"maxSizeFraction":"0.35"');
    expect(messages).toContain('"shorts":true');
    // The caller's constants must not be what the model is told, on any channel.
    expect(messages).not.toContain('"leverage":"2"');
    expect(messages).not.toContain('"maxSizeFraction":"0.25"');
    expect(JSON.stringify(body().tools)).not.toContain('0.25');
  });

  it('bounds sizeFraction by the RECORDED limit, so the bound cannot contradict the payload', async () => {
    // 0.30 exceeds the caller's 0.25 but is within the recorded 0.35. Before the fix this was rejected:
    // the model believed the payload, proposed a legal size, and the harness scored it as a schema
    // failure — inflating the abstention rate with the harness's own inconsistency.
    const { fetchFn } = captureFetch(openLong(0.3));
    const res = await replayPlanRow(cfg(), 'sys', 'pb', payload(PERP_CAPS), fetchFn);
    expect(res.capsSource).toBe('recorded');
    expect(res.ok).toBe(true);
    expect(res.action).toBe('open_long');
    expect(res.plan?.sizeFraction).toBe('0.3');
  });

  it('still enforces the recorded limit as a real bound', async () => {
    // Faithful, not permissive: 0.40 is over the recorded 0.35 and must fail.
    const { fetchFn } = captureFetch(openLong(0.4));
    const res = await replayPlanRow(cfg(), 'sys', 'pb', payload(PERP_CAPS), fetchFn);
    expect(res.ok).toBe(false);
    // Usage is still reported — a schema-rejected call burned tokens and must not vanish from cost.
    expect(res.usage?.inputTokens).toBe(10);
    expect(res.capsSource).toBe('recorded');
  });

  it('tells the model shorts are unavailable when the row recorded shorts:false', async () => {
    // The study ran with shortsEnabled:true across a corpus whose 139 spot rows recorded shorts:false,
    // so the replay advertised the short side on rows where live did not.
    //
    // 2026-07-30: same relocation as the ceiling/leverage test above — the tool's own "spot-only;
    // shorts are not available" sentence is gone (it was the last capability fork in submit_trade),
    // and the recorded `capabilities.shorts:false` in the payload is what tells the model now. The
    // tool's surviving sentence states the precondition and points AT that block, so the two agree.
    const spot = { ...PERP_CAPS, venue: 'binance', shorts: false, leverage: '1' };
    const { fetchFn, body } = captureFetch(openLong(0.1));
    const res = await replayPlanRow(
      cfg({ shortsEnabled: true }),
      'sys',
      'pb',
      payload(spot),
      fetchFn,
    );
    expect(res.capsSource).toBe('recorded');
    expect(userText(body())).toContain('"shorts":false');
    // The caller's shortsEnabled:true must not leak onto any channel the model reads.
    expect(userText(body())).not.toContain('"shorts":true');
    expect(JSON.stringify(body().tools)).toContain('capabilities.shorts is true');
  });

  it('does not itself reject an open_short on a shorts:false symbol — that is a downstream gate', async () => {
    // Recorded because the first version of this test assumed the schema enforced it. It does not: the
    // enum always carries open_short and the violation is caught and journaled downstream. So making
    // capabilities faithful changes what the model is TOLD, not what this function accepts.
    const spot = { ...PERP_CAPS, venue: 'binance', shorts: false, leverage: '1' };
    const { fetchFn } = captureFetch({ ...openLong(0.1), action: 'open_short' });
    const res = await replayPlanRow(cfg(), 'sys', 'pb', payload(spot), fetchFn);
    expect(res.ok).toBe(true);
    expect(res.action).toBe('open_short');
  });

  it('falls OPEN to config capabilities when the payload carries none, and says so', async () => {
    // Measurement harness: it must never refuse to measure. The caller is the one that fails closed —
    // the playbook-space study requires capsSource === 'recorded' for every row.
    const noCaps = JSON.stringify({ symbol: 'X' });
    const { fetchFn } = captureFetch(openLong(0.1));
    const res = await replayPlanRow(cfg(), 'sys', 'pb', noCaps, fetchFn);
    expect(res.capsSource).toBe('config');
    expect(res.ok).toBe(true);

    // The fallback bound really ran, proved at the layer that enforces it rather than by matching
    // "0.25" in the request text: 0.30 is legal under the RECORDED 0.35 and illegal under the config
    // 0.25, so a rejection here can only come from the config bound.
    const over = captureFetch(openLong(0.3));
    const rejected = await replayPlanRow(cfg(), 'sys', 'pb', noCaps, over.fetchFn);
    expect(rejected.capsSource).toBe('config');
    expect(rejected.ok).toBe(false);
  });

  it('SHOWS the config ceiling on the fallback path, so the bound is never enforced unstated', async () => {
    // The hole this closes (opened 2026-07-30 when the tool description stopped carrying capability
    // text, closed the same day): on the config path the tool bakes in no ceiling AND the row has no
    // capabilities block to read, so the model was bound at cfg.sizeFractionMax without ever being
    // told the number — a proposal over it was schema-rejected for a limit it was never shown. That
    // is the same manufactured abstention this file exists to remove (the recorded instance measured
    // 2.5% entry against a live 16.1%), reached through silence instead of through disagreement.
    //
    // The fix mirrors LIVE rather than forking the tool: live sends the number in the payload's
    // capabilities block and keeps one byte-identical tool at cache position 0, so the fallback block
    // is appended to the user message too.
    const noCaps = JSON.stringify({ symbol: 'X' });
    const { fetchFn, body } = captureFetch(openLong(0.1));
    await replayPlanRow(cfg({ shortsEnabled: true }), 'sys', 'pb', noCaps, fetchFn);
    const messages = userText(body());
    expect(messages).toContain('"maxSizeFraction":"0.25"');
    expect(messages).toContain('"shorts":true');
    expect(messages).toContain('binanceusdm');
    // Still not in the tool: the tool JSON must stay identical across rows or a mixed batch
    // invalidates both cache breakpoints on every call.
    expect(JSON.stringify(body().tools)).not.toContain('0.25');
    // The recorded row is untouched by any of this — it already carries its own block, and appending
    // a second one would contradict it.
    const recordedCall = captureFetch(openLong(0.1));
    await replayPlanRow(cfg(), 'sys', 'pb', payload(PERP_CAPS), recordedCall.fetchFn);
    expect(userText(recordedCall.body())).toBe(`pb\n\n${payload(PERP_CAPS)}`);
  });

  it('reports capsSource on failure paths, not only on success', async () => {
    // A caller checking faithfulness must not have that answer withheld by an unrelated failure.
    const failing = (() =>
      Promise.resolve(new Response('', { status: 500 }))) as unknown as typeof fetch;
    const res = await replayPlanRow(cfg(), 'sys', 'pb', payload(PERP_CAPS), failing);
    expect(res.ok).toBe(false);
    expect(res.capsSource).toBe('recorded');
  });
});
