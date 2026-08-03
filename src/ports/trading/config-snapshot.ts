// Composition-root optional override for the boot-time config-snapshot write — mirrors
// FUNDING_PAYMENTS's own port-file-local token convention (ports/venue/funding-payments.ts).
export const CONFIG_SNAPSHOT_WRITER = Symbol('CONFIG_SNAPSHOT_WRITER');

// Structurally identical to ConfigSnapshotRepository.upsert's own ConfigSnapshotInsert param
// (database/repositories/trading/config-snapshot.repository.ts) — kept as its own minimal port here
// so write-config-snapshot.ts's sink parameter and TradingRuntimeService's injected dependency both
// type-check against the same shape without either importing the concrete repository class.
export interface ConfigSnapshotWriterPort {
  upsert(snapshot: {
    hash: string;
    config: unknown;
    mode: 'paper' | 'testnet' | 'live';
  }): Promise<void>;
}
