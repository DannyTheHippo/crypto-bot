import type { AgentIndicators, RegimeTags, SimilarSetupRow } from '../../../ports/agentic-strategy';

// R2 episodic memory: pure regime-tag derivation and retrieval rendering. deriveRegimeTags is a PURE
// function of features the market payload already carries (see agent-prompt.ts's buildMarketPayload):
// the EMA fast/slow spread, the ATR-to-price ratio, the current funding rate when a derivatives
// snapshot is present, and the UTC hour of the decision's eventTime. Both the WRITE side
// (agentic.strategy.ts stamps the tags on every journaled row) and the READ side
// (anthropic-agent-client.ts derives the same tags to retrieve matching past setups) call this one
// function, so a stored tag and a query tag can never drift.

// Trend band: |emaFast/emaSlow - 1| at/below this is 'flat' — a sub-0.1% EMA separation is noise, not
// a directional regime. Vol bands: ATR as a fraction of last close — below VOL_LOW_MAX is 'low', at or
// above VOL_HIGH_MIN is 'high', otherwise 'mid'. Funding band: |fundingRate| at/below FUNDING_FLAT_BAND
// rounds to 'flat' (a settled rate this small is directionally neutral).
const TREND_FLAT_BAND = 0.001;
const VOL_LOW_MAX = 0.005;
const VOL_HIGH_MIN = 0.015;
const FUNDING_FLAT_BAND = 0.00001;

// Hard ceilings on the rendered block: at most MAX_SIMILAR_SETUPS entries (newest-first, recency-
// weighted) and MAX_SIMILAR_SETUPS_CHARS total characters — a token-bounded context add, never an
// unbounded history dump. The char cap is belt-and-braces on top of the entry cap: it guarantees the
// ceiling regardless of any future change to the per-entry line shape.
export const MAX_SIMILAR_SETUPS = 5;
export const MAX_SIMILAR_SETUPS_CHARS = 600;

export function deriveRegimeTags(args: {
  readonly indicators: AgentIndicators | null;
  readonly fundingRate?: number | null;
  readonly eventTime: number;
}): RegimeTags | null {
  const { indicators, fundingRate, eventTime } = args;
  // No indicators (candle history under warmup) ⇒ no trend/vol fingerprint to key on: return null so
  // the row is left untagged rather than tagged on a fabricated regime. Fail-open — an untagged row is
  // simply never retrieved, never a wrong match.
  if (indicators === null) return null;
  const { emaFast, emaSlow, atr14, lastClose } = indicators;
  if (
    !Number.isFinite(emaFast) ||
    !Number.isFinite(emaSlow) ||
    emaSlow === 0 ||
    !Number.isFinite(atr14) ||
    !Number.isFinite(lastClose) ||
    lastClose <= 0
  ) {
    return null;
  }
  const spread = emaFast / emaSlow - 1;
  const trend: RegimeTags['trend'] =
    spread > TREND_FLAT_BAND ? 'up' : spread < -TREND_FLAT_BAND ? 'down' : 'flat';
  const atrPct = atr14 / lastClose;
  const vol: RegimeTags['vol'] =
    atrPct < VOL_LOW_MAX ? 'low' : atrPct >= VOL_HIGH_MIN ? 'high' : 'mid';
  const session = sessionBucket(eventTime);
  // funding is part of the fingerprint ONLY when a derivatives snapshot supplied a rate — omitted
  // (not defaulted to 'flat') on the spot lane / stale feed, so a spot setup never mis-matches a perp
  // setup on a fabricated neutral-funding tag.
  if (fundingRate === undefined || fundingRate === null || !Number.isFinite(fundingRate)) {
    return { trend, vol, session };
  }
  const funding: RegimeTags['funding'] =
    fundingRate > FUNDING_FLAT_BAND
      ? 'positive'
      : fundingRate < -FUNDING_FLAT_BAND
        ? 'negative'
        : 'flat';
  return { trend, vol, funding, session };
}

// UTC session buckets: asia 00:00–07:59, eu 08:00–15:59, us 16:00–23:59 — coarse thirds of the UTC
// day, enough to separate the liquidity regimes without over-fragmenting the retrieval corpus.
function sessionBucket(eventTime: number): RegimeTags['session'] {
  const hour = new Date(eventTime).getUTCHours();
  if (hour < 8) return 'asia';
  if (hour < 16) return 'eu';
  return 'us';
}

// Renders the ≤5 retrieved setups (already newest-first from the repository) into ONE token-bounded
// context string, each line labeled 'sim' when it came from synthetic replay practice. Returns null
// when nothing was retrieved (⇒ the caller omits the payload key entirely — no empty scaffolding).
export function renderSimilarSetups(
  setups: readonly SimilarSetupRow[],
  tags: RegimeTags,
): string | null {
  if (setups.length === 0) return null;
  const regime = [
    tags.trend,
    `${tags.vol}-vol`,
    tags.funding ? `${tags.funding}-funding` : null,
    tags.session,
  ]
    .filter((p): p is string => p !== null)
    .join('/');
  const entries = setups.slice(0, MAX_SIMILAR_SETUPS).map((s) => {
    const closeStr = s.close ?? 'n/a';
    const moveStr =
      s.priceMovePct === null
        ? 'n/a'
        : `${s.priceMovePct >= 0 ? '+' : ''}${s.priceMovePct.toFixed(2)}%`;
    return `${s.synthetic ? 'sim ' : ''}${s.action} @ ${closeStr} → ${moveStr}`;
  });
  const block = `${entries.length} prior ${regime} setup${
    entries.length === 1 ? '' : 's'
  } (newest first): ${entries.join('; ')}`;
  return block.length > MAX_SIMILAR_SETUPS_CHARS
    ? `${block.slice(0, MAX_SIMILAR_SETUPS_CHARS - 1)}…`
    : block;
}
