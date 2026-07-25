import Decimal from 'decimal.js';
import type { AgentDecisionRow } from '../../../ports/strategy/agentic-strategy';
import type { RoundTripEvidence } from '../../../ports/trading/promotion';
import { attributeVersion } from './promotion-evaluator';

// ── Per-playbook-version net-PnL digest for the reflection loop (X8) ──────────
//
// Version stamping (playbookVersion journaled on every decide) and entry-keyed trip attribution
// already exist — this module only tabulates: for each closed round trip, join it to the playbook
// version active at its entry via promotion-evaluator.ts's OWN attributeVersion (the exact join the
// auto-promotion verdict already trusts, never a parallel one), then sum realized-net (fees already
// folded into RoundTripEvidence.netPnl) per version. Reflection reads this to judge its own past
// mints by realized results — the anti-ratchet counterweight this file's postMortems already give it
// for skipped entries, now given for MINTED CHANGES too.
//
// WINDOW SEMANTICS (backlog #39 / Bug C cfb2ed3 / Bug E 309bbfc class): this function itself performs
// no truncation — `trips` and `decisions` must already be the caller's epoch-bounded reads (reflection
// .service.ts feeds RoundTripEvidenceReader's epoch-bounded recentRoundTrips + a CAP-bounded, not
// recency-windowed, journal.recentVersioned — see call site). A trip that cannot be joined to a
// version (pre-stamp/legacy, or the journal read didn't reach far enough back) falls into
// `unattributed` — fail toward "unknown", never toward misattributing it to the wrong version.
//
// Money-path note: RoundTripEvidence.netPnl already arrives as an exact decimal STRING (realized −
// fees, minted by round-trip-evidence.reader.ts's toEvidence) — summed here with Decimal, never
// parseFloat/Number(), and re-emitted as toFixed() strings (money-path convention, even though this
// is reflection prompt material, not a money mint).

const MAX_VERSION_ROWS = 7; // + 1 unattributed line ⇒ ≤8 lines total in the digest.

export interface VersionPnlRow {
  readonly version: number;
  readonly trips: number;
  // Field name itself carries the caveat: realized − fees only, LLM spend is lane-shared and not
  // attributable per version (same exclusion promotion-evaluator.ts's own per-version comparison
  // makes, see its header comment) — never build a per-version cost split that doesn't exist yet.
  readonly netPnlFeesOnly: string;
}

export interface VersionPnlDigest {
  // Ascending by version; when over MAX_VERSION_ROWS, the OLDEST versions are dropped — the model is
  // judging what to do NEXT, so the most recent mints are the ones worth weighing.
  readonly rows: readonly VersionPnlRow[];
  readonly unattributed: { readonly trips: number; readonly netPnlFeesOnly: string };
}

export function computeVersionPnlDigest(
  trips: readonly RoundTripEvidence[],
  decisions: readonly AgentDecisionRow[],
): VersionPnlDigest {
  const byVersion = new Map<number, { trips: number; net: Decimal }>();
  let unattributedTrips = 0;
  let unattributedNet = new Decimal(0);
  for (const trip of trips) {
    const net = new Decimal(trip.netPnl);
    const version = attributeVersion(decisions, trip.strategyId, trip.symbol, trip.openedAt);
    if (version === null) {
      unattributedTrips += 1;
      unattributedNet = unattributedNet.plus(net);
      continue;
    }
    const prev = byVersion.get(version) ?? { trips: 0, net: new Decimal(0) };
    prev.trips += 1;
    prev.net = prev.net.plus(net);
    byVersion.set(version, prev);
  }
  const sorted = [...byVersion.entries()].sort((a, b) => a[0] - b[0]);
  const rows = sorted
    .slice(-MAX_VERSION_ROWS)
    .map(([version, s]) => ({ version, trips: s.trips, netPnlFeesOnly: s.net.toFixed() }));
  return {
    rows,
    unattributed: { trips: unattributedTrips, netPnlFeesOnly: unattributedNet.toFixed() },
  };
}
