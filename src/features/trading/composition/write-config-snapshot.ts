// Minimal structural shapes so the unit test needs neither the Nest TradingRuntimeModule graph nor a
// real Drizzle db — same reason seed-agent-last-success.ts is its own module.
interface ConfigSnapshotSink {
  upsert(snapshot: {
    hash: string;
    config: unknown;
    mode: 'paper' | 'testnet' | 'live';
  }): Promise<void>;
}
interface WriteLog {
  log(message: string): void;
  warn(message: string): void;
}

// Root-cause fix: ConfigSnapshotRepository.upsert (bound at CONFIG_SNAPSHOT_REPO) has never had a
// caller, so config_snapshots has stayed empty since the table shipped — the sweep's
// config_snapshot_missing alarm is honest, not a false positive. This is the one call site.
//
// Fails OPEN, deliberately: this is a measurement/evidence input, not a permission or safety gate —
// PROMOTION_EVIDENCE_EPOCH/PROMOTION_DUST_NOTIONAL still govern real money sizing/vetoes regardless
// of whether their own knob values got a durable row this boot. A broken snapshot writer must never
// refuse the boot it is trying to describe: a write failure leaves config_snapshots exactly as it
// was, and the sweep's W3 reader — which fails CLOSED — reports the absence. Writer open, reader
// closed, deliberately asymmetric. `sink` undefined (test/ci/no-DB — CONFIG_SNAPSHOT_WRITER's own
// composition-root gate) is the same "stays as it was" outcome, silently, mirroring
// seedAgentLastSuccess's undefined-stats no-op just above this call site.
//
// `buildSnapshot` is a thunk, not pre-computed args: the caller's payload assembly (e.g.
// TradingRuntimeService.configSnapshotPayload, which walks a partial-under-test AppConfig) can throw,
// and that throw must land inside THIS function's own try — the fail-open direction above covers a
// throwing assembler exactly as it covers a rejecting sink. Evaluating the payload before calling in
// would let that throw escape into startTrading() and refuse the boot it is trying to describe.
export async function writeConfigSnapshot(
  sink: ConfigSnapshotSink | undefined,
  log: WriteLog,
  buildSnapshot: () => { hash: string; config: unknown; mode: 'paper' | 'testnet' | 'live' },
): Promise<void> {
  if (sink === undefined) return;
  try {
    const { hash, config, mode } = buildSnapshot();
    await sink.upsert({ hash, config, mode });
    log.log(`config snapshot activated: hash=${hash.slice(0, 12)} mode=${mode}`);
  } catch (err) {
    log.warn(
      `config snapshot write failed (${err instanceof Error ? err.message : String(err)}) — ` +
        `config_snapshots stays as it was; the sweep's config_snapshot_missing/drift check reports the absence`,
    );
  }
}
