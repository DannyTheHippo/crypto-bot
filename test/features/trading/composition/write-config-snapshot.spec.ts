import { describe, it, expect } from 'vitest';
import { writeConfigSnapshot } from '../../../../src/features/trading/composition/write-config-snapshot';
import { TradingRuntimeService } from '../../../../src/features/trading/composition/trading-runtime.module';

// config_snapshot_missing root-cause fix: CONFIG_SNAPSHOT_REPO's upsert has never had a caller since
// 214eb7d, so config_snapshots has stayed empty. These pin the writer AND its fail-open direction: a
// broken/absent measurement input must never refuse the boot it is trying to describe.

function fakes() {
  const upserted: Array<{ hash: string; config: unknown; mode: 'paper' | 'testnet' | 'live' }> = [];
  const logged: string[] = [];
  const warned: string[] = [];
  return {
    sink: {
      upsert: (s: { hash: string; config: unknown; mode: 'paper' | 'testnet' | 'live' }) => {
        upserted.push(s);
        return Promise.resolve();
      },
    },
    log: {
      log: (m: string) => {
        logged.push(m);
      },
      warn: (m: string) => {
        warned.push(m);
      },
    },
    upserted,
    logged,
    warned,
  };
}

describe('writeConfigSnapshot', () => {
  it('calls the sink with the resolved hash/config/mode and logs success', async () => {
    const f = fakes();
    const config = { agentic: { model: 'claude' } };
    await writeConfigSnapshot(f.sink, f.log, () => ({
      hash: 'abc123def456',
      config,
      mode: 'paper',
    }));
    expect(f.upserted).toEqual([{ hash: 'abc123def456', config, mode: 'paper' }]);
    expect(f.logged).toHaveLength(1);
    expect(f.logged[0]).toContain('abc123def456'.slice(0, 12));
    expect(f.logged[0]).toContain('paper');
    expect(f.warned).toEqual([]);
  });

  // Writer open, reader closed (write-config-snapshot.ts's own header): a rejecting sink must never
  // throw out of the writer — the sweep's own fail-closed W3 reader is what reports the absence.
  it('warns and resolves when the sink rejects — never throws out of the writer', async () => {
    const f = fakes();
    f.sink.upsert = () => Promise.reject(new Error('connection terminated'));
    await expect(
      writeConfigSnapshot(f.sink, f.log, () => ({
        hash: 'abc123def456',
        config: {},
        mode: 'live',
      })),
    ).resolves.toBeUndefined();
    expect(f.warned).toHaveLength(1);
    expect(f.warned[0]).toContain('connection terminated');
    expect(f.logged).toEqual([]);
  });

  // CONFIG_SNAPSHOT_WRITER resolves to undefined under test/ci/no-DB (PersistenceOverridesModule's
  // own gate) — the same silent "stays as it was" outcome as a real write, not a warn.
  it('no-ops silently when no writer is bound', async () => {
    const f = fakes();
    await expect(
      writeConfigSnapshot(undefined, f.log, () => ({
        hash: 'abc123def456',
        config: {},
        mode: 'testnet',
      })),
    ).resolves.toBeUndefined();
    expect(f.logged).toEqual([]);
    expect(f.warned).toEqual([]);
  });

  // Argument-evaluation-escapes-the-fail-open-boundary regression: TradingRuntimeService's real call
  // site passes a thunk whose body calls configSnapshotPayload() (Object.entries over a possibly
  // partial config). If that assembly ran BEFORE this function's own try (as it once did, passed as
  // pre-evaluated args), a throwing assembler would escape into startTrading() and refuse the boot
  // this write only exists to describe. Pinning the thunk shape keeps that assembly inside the try.
  it('warns and resolves when the snapshot thunk itself throws — assembly runs inside the try', async () => {
    const f = fakes();
    await expect(
      writeConfigSnapshot(f.sink, f.log, () => {
        throw new Error('Cannot convert undefined or null to object');
      }),
    ).resolves.toBeUndefined();
    expect(f.warned).toHaveLength(1);
    expect(f.warned[0]).toContain('Cannot convert undefined or null to object');
    expect(f.upserted).toEqual([]);
    expect(f.logged).toEqual([]);
  });
});

// Payload-coherence regression: configSnapshotPayload() must be a pure function of configHash — a
// field that varies while the hash stays constant (bootId/gitSha) must not ride along in the stored
// `config`, or onConflictDoUpdate's activatedAt bump freezes a stale value against a fresh timestamp.
// TradingRuntimeService's own constructor wires the full app DI graph — Object.create bypasses it
// and stubs only the `config.raw` getter's result configSnapshotPayload() itself reads (same harness
// pattern as trading-runtime-seed-configured-label-sets.spec.ts / trading-runtime-log-portfolio.spec.ts).
interface ConfigSnapshotPayloadHarness {
  configSnapshotPayload(): Record<string, unknown>;
}

// All five hash-excluded secrets (db + the four §10 live secrets) carry distinctive sentinel values
// distinct from bootId/gitSha's own sentinels below — a payload leak here would violate hard rule 7
// (no secrets in code/logs/fixtures), so this asserts absence of something that WOULD otherwise be
// present, not absence of something never supplied (the tautology this replaces).
function makePayloadHarness(
  overrides: { promotionEvidenceEpoch?: string } = {},
): ConfigSnapshotPayloadHarness {
  const service = Object.create(TradingRuntimeService.prototype) as Record<string, unknown>;
  service['config'] = {
    raw: {
      app: { port: 3000, bootId: 'boot-1234', gitSha: 'deadbeef' },
      mode: { requestedMode: 'paper', configMode: 'paper', sandboxEnv: 'testnet', downgrades: [] },
      db: { url: 'postgresql://sentinel-user:sentinel-pass@sentinel-host/sentinel-db' },
      venues: [{ id: 'binance', environment: 'paper' }],
      venueCapitalSplit: { binance: '1' },
      agentic: {
        model: 'claude-sonnet-5',
        promotionDustNotional: '0.5',
        promotionEvidenceEpoch: overrides.promotionEvidenceEpoch,
      },
      risk: {},
      recovery: {},
      perp: {},
      strategy: {},
      derivativesFeed: {},
      fundingIngest: {},
      sentimentFeed: {},
      fearGreedFeed: {},
      tradeFlowFeed: {},
      positioningFeed: {},
      liquidationFeed: {},
      marketData: {},
      observability: {},
      configHash: 'abc123def456',
      liveApiKey: 'sentinel-live-api-key',
      liveApiSecret: 'sentinel-live-api-secret',
      armingSecret: 'sentinel-arming-secret',
      liveBaseUrlOverride: 'https://sentinel-live-base-url.example',
    },
  };
  return service as unknown as ConfigSnapshotPayloadHarness;
}

describe('TradingRuntimeService.configSnapshotPayload', () => {
  it('excludes bootId and gitSha — fields excluded from configHash must be excluded from the stored payload', () => {
    const payload = makePayloadHarness().configSnapshotPayload();
    const app = payload['app'] as Record<string, unknown>;
    expect(app['bootId']).toBeUndefined();
    expect(app['gitSha']).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('boot-1234');
    expect(JSON.stringify(payload)).not.toContain('deadbeef');
  });

  it('excludes db and the four live secrets — hard rule 7 (no secrets in code/logs/fixtures)', () => {
    const payload = makePayloadHarness().configSnapshotPayload();
    const serialized = JSON.stringify(payload);
    expect(payload['db']).toBeUndefined();
    expect(payload['liveApiKey']).toBeUndefined();
    expect(payload['liveApiSecret']).toBeUndefined();
    expect(payload['armingSecret']).toBeUndefined();
    expect(payload['liveBaseUrlOverride']).toBeUndefined();
    expect(serialized).not.toContain('sentinel-user');
    expect(serialized).not.toContain('sentinel-pass');
    expect(serialized).not.toContain('sentinel-live-api-key');
    expect(serialized).not.toContain('sentinel-live-api-secret');
    expect(serialized).not.toContain('sentinel-arming-secret');
    expect(serialized).not.toContain('sentinel-live-base-url');
  });

  it('keeps every other getter, including the promotion knobs', () => {
    const payload = makePayloadHarness({
      promotionEvidenceEpoch: '2026-07-18T15:36:14Z',
    }).configSnapshotPayload();
    const agentic = payload['agentic'] as Record<string, unknown>;
    expect(agentic['promotionDustNotional']).toBe('0.5');
    expect(agentic['promotionEvidenceEpoch']).toBe('2026-07-18T15:36:14Z');
    expect(Object.keys(payload).length).toBeGreaterThan(2);
    expect(payload).toHaveProperty('risk');
    expect(payload).toHaveProperty('venues');
  });

  it('keeps app.port — only hash-excluded fields are stripped from app, not the whole object', () => {
    const payload = makePayloadHarness().configSnapshotPayload();
    const app = payload['app'] as Record<string, unknown>;
    expect(app['port']).toBe(3000);
  });

  // S9 (config_snapshot_shape_unknown): PROMOTION_EVIDENCE_EPOCH is documented-optional — absent is a
  // legitimate "all-time" configuration, not a malformed row. JSON.stringify silently drops an
  // undefined-valued key, which would make a correctly-unset epoch indistinguishable from a row whose
  // shape the sweep reader has never seen, so an unset epoch must be stamped explicit null.
  it('stamps promotionEvidenceEpoch explicit null when unset, distinguishable from an unrecognised shape', () => {
    const payload = makePayloadHarness().configSnapshotPayload();
    const agentic = payload['agentic'] as Record<string, unknown>;
    expect(agentic['promotionEvidenceEpoch']).toBeNull();
    expect(JSON.stringify(payload)).toContain('"promotionEvidenceEpoch":null');
  });

  // S3 self-verification: the stored config's own configHash field is always the empty-string
  // placeholder used to compute the hash (mirrors validate()'s own canonicalJsonWithoutSecrets input,
  // {...appConfig, configHash: ''}) — the real hash lives only in the row's separate `hash` PK column.
  it('stores configHash as the empty-string hash-input placeholder, never the real hash value', () => {
    const payload = makePayloadHarness().configSnapshotPayload();
    expect(payload).toHaveProperty('configHash', '');
  });
});
