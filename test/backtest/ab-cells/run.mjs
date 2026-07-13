// Info-context × thinking 2×2 factorial cell table — RESEARCH TOOLING (test/backtest/, off the
// production gate). $0, no LLM calls: reads agent_decisions/order_intents/fills directly off the
// live DB (DATABASE_URL loaded from <repo>/.env, NEVER printed) and prints the cell table the
// daily loop is expected to run every pass once enough volume accrues.
//
// The two arms (anthropic-agent-client.ts's prepareDecideContext):
//   info-context — control strips the derivatives+crossSymbol+tradeFlow+positioning bundle from
//     the payload (one boolean gates all four — see that method's own comment); treatment sends it.
//   thinking     — treatment runs the decide call with `thinking:{type:'adaptive'}` instead of the
//     hard 'disabled' (backlog #42); this changes a REQUEST PARAM only, zero prompt/payload bytes,
//     so it is recoverable ONLY via the '+th1' tag anthropic-agent-client.ts stacks onto the
//     templateVersion string fed into agent-prompt.ts's computePromptHash (mechanism landed
//     2026-07-13, commit eff1d95).
//
// METHOD — read this before trusting a cell:
//   info-context arm: PAYLOAD-BASED (deterministic, preferred per task brief over hash-guessing). A
//   prompt_hash GROUP is classified 'treatment' if ANY row in the group carries a derivatives/
//   crossSymbol/tradeFlow/positioning key in its input_payload JSON (the four move together under
//   one control arm), 'control' otherwise. Caveat: a group can under-count as 'control' if every
//   feed happened to be stale on every row in that group despite running the treatment arm — this
//   script cannot distinguish "arm stripped it" from "feed never had fresh data" for an all-empty
//   group; it is reported as 'control' either way (documented, not silently assumed correct).
//
//   thinking arm: HASH-FORWARD-COMPUTATION, best-effort, per distinct prompt_hash. Since the +th1
//   tag changes no visible bytes, this script reconstructs BOTH candidate templateVersion strings
//   (with and without the trailing +th1 tag) for each group — using that group's own info-arm
//   classification above for the feed tags, a globally-detected sentiment flag and plan-mode flag
//   (booleans inferred from whether ANY row in the whole --since window shows a sentiment block /
//   a non-null plan_json — a per-boot config constant, not a per-row one), the group's
//   playbookContent (joined from agent_playbook_versions by playbook_version) and model (row.model)
//   — then forward-computes both candidate hashes via the SAME computePromptHash formula
//   (agent-prompt.ts) and compares against the group's actual observed hash. Hardcoded constants
//   (template-version tags, DECISION_TOOL/PLAN_TOOL schemas) mirror agent-prompt.ts AS WRITTEN —
//   if those bump, this script's copies need updating too, or every group will read UNKNOWN.
//   Shorts (x1/PLAN_SHORTS) are assumed OFF; a group with a 'short' action anywhere flips a global
//   guard that forces every group's thinking arm to UNKNOWN rather than guessing the wrong tool
//   schema. A group whose observed hash matches NEITHER candidate (unresolved playbook version,
//   wrong tool/shorts assumption, ...) is reported UNKNOWN for that group specifically. If EVERY
//   non-empty group ends up UNKNOWN, the script prints a 2×1 (info-arm only) table plus a note
//   instead of fabricating a 2×2 split it cannot support.
//
// Closed-trip attribution: a 'long' decide row is joined to the order_intents row it produced via
// (strategy_id, symbol, event_time = source_event_time, side = 'BUY') — the same triple
// agentic.strategy.ts stamps onto every Signal it emits. Fills for every (strategy_id, symbol)
// pair touched by the window are then walked into closed round trips with a simplified port of
// domain/risk/round-trips.ts's walkRoundTrips (no slippage evidence needed here); a cycle is
// attributed to a cell iff its OPENING fill's intent_id is one of that cell's mapped entry intents.
// KNOWN LIMITATION: this join assumes the legacy (non-plan-mode) immediate-entry path, where the
// entry intent's source_event_time equals the decide row's own event_time — under AGENTIC_PLAN_MODE
// the actual resting entry is placed by plan-executor bars later, at a different event_time, so
// this script will under-attribute (never over-attribute) trips for a plan-mode deployment; such
// cycles are simply excluded from every cell's trip count rather than mis-attributed. VERIFIED
// against the live DB (2026-07-13): AGENTIC_PLAN_MODE is on for this deployment (plan_json rows
// exist) and every closed round trip walked so far opened via a plan-executor-placed resting
// entry, so trips/grossPnl/fees/netBps read zero for EVERY cell right now — that is this join gap
// firing, not "no trades happened yet." Finding a decide→plan-executor-entry link is future work.
//
// Thinking-arm scope note: a small number of decide rows are served by BatchingAgentClient's
// coalesced submit_portfolio call (consult_id populated) rather than the single-symbol path this
// script's forward-hash reconstruction models — those rows stack an additional '+pf1'/'+pf2' tag
// and swap in PORTFOLIO_TOOL, which this script does NOT reconstruct (out of scope for this pass).
// Such groups correctly fall through to thinking-arm UNKNOWN (never mis-labelled) rather than being
// silently guessed; wiring PORTFOLIO_TOOL support in is a follow-up if the loop needs it resolved.
//
// Money-path note: this is a TOY RESEARCH METRIC in the same sense as counterfactual-scoring.ts's
// own header comment — Decimal is used throughout for the actual PnL/fee/cost arithmetic (never a
// money MINTING path, no Price/Qty branded type is created here), matching this repo's research-
// tooling convention (bounds-calibration/run.mjs, counterfactual-scoring.ts).
//
// Usage:
//   node test/backtest/ab-cells/run.mjs [--since <ISO8601>]
//   --since defaults to 2026-07-13T00:00:00Z (the day the info-context+thinking A/B mechanism
//   landed). Cells are expected to be sparse or entirely empty immediately after that date — this
//   script prints the table with zeros rather than erroring on an empty window.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import Decimal from 'decimal.js';

const { Pool } = pg;

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MTOK = new Decimal(1_000_000);
const DUST_NOTIONAL_DEFAULT = '5'; // mirrors PROMOTION_DUST_NOTIONAL's own default (environment.config.ts)

// Hardcoded mirrors of agent-prompt.ts's exported template-version tags AS WRITTEN — see this
// file's header comment on why these must track that file if it changes.
const BASE_TEMPLATE_LEGACY = 'v5';
const BASE_TEMPLATE_PLAN = 'p3';
const TAG_DERIVATIVES = 'd1';
const TAG_SENTIMENT = 's1';
const TAG_CROSS_SYMBOL = 'xs1';
const TAG_TRADEFLOW = 'tf1';
const TAG_POSITIONING = 'pos1';
const TAG_THINKING = 'th1';

// Verbatim mirrors of agent-prompt.ts's DECISION_TOOL / PLAN_TOOL (non-shorts variants only — see
// the anomalousShort guard below) — key order matters, JSON.stringify is order-sensitive and feeds
// directly into the forward-computed hash.
const DECISION_TOOL = {
  name: 'submit_decision',
  description: 'Submit your trading decision for this symbol.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['long', 'flat', 'hold'],
        description:
          "'long' to open or hold a long position, 'flat' to close an open position (if already flat, use 'hold'), 'hold' to leave the current position unchanged",
      },
      confidence: {
        type: 'number',
        description: '0..1 conviction; scales position size',
      },
      rationale: {
        type: 'string',
        description: 'One short paragraph explaining the decision',
      },
    },
    required: ['action', 'confidence', 'rationale'],
    additionalProperties: false,
  },
};

const PLAN_BOUNDS = {
  entryOffsetBps: { min: -50, max: 50 },
  stopLossPct: { min: 0.002, max: 0.05 },
  takeProfitPct: { min: 0.001, max: 0.1 },
  entryValidityBars: { min: 1, max: 8 },
  maxHoldBars: { min: 4, max: 96 },
};

const PLAN_TOOL = {
  name: 'submit_plan',
  description:
    'Submit your trading decision for this symbol, including a managed trade plan when opening a long.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['long', 'flat', 'hold'],
        description:
          "'long' to open a new long (must include a plan), 'flat' to close an open position (if already flat, use 'hold'), 'hold' to leave the current position/plan unchanged — optionally attach a plan to a 'hold' to (re)arm managed execution of an open position",
      },
      confidence: {
        type: 'number',
        description: '0..1 conviction; scales position size',
      },
      rationale: {
        type: 'string',
        description: 'One short paragraph explaining the decision',
      },
      plan: {
        type: 'object',
        description:
          "The managed trade plan — REQUIRED when action is 'long'; may also accompany 'hold' while a position is open, to re-attach managed execution (entry fields are then ignored).",
        properties: {
          entryOffsetBps: {
            type: 'integer',
            description: `Basis points below (positive) or above (negative) the last closed candle close to rest the entry at; integer in [${PLAN_BOUNDS.entryOffsetBps.min}, ${PLAN_BOUNDS.entryOffsetBps.max}]`,
          },
          stopLossPct: {
            type: 'number',
            description: `Stop-loss as a fraction below entry price, in [${PLAN_BOUNDS.stopLossPct.min}, ${PLAN_BOUNDS.stopLossPct.max}]`,
          },
          takeProfitPct: {
            type: 'number',
            description: `Take-profit as a fraction above entry price, in [${PLAN_BOUNDS.takeProfitPct.min}, ${PLAN_BOUNDS.takeProfitPct.max}]`,
          },
          entryValidityBars: {
            type: 'integer',
            description: `Bars the resting entry stays live before being cancelled if unfilled; integer in [${PLAN_BOUNDS.entryValidityBars.min}, ${PLAN_BOUNDS.entryValidityBars.max}]`,
          },
          maxHoldBars: {
            type: 'integer',
            description: `Maximum bars to hold the filled position before a forced exit; integer in [${PLAN_BOUNDS.maxHoldBars.min}, ${PLAN_BOUNDS.maxHoldBars.max}]`,
          },
        },
        required: [
          'entryOffsetBps',
          'stopLossPct',
          'takeProfitPct',
          'entryValidityBars',
          'maxHoldBars',
        ],
        additionalProperties: false,
      },
    },
    required: ['action', 'confidence', 'rationale'],
    additionalProperties: false,
  },
};

// Mirrors agent-prompt.ts's computePromptHash exactly (NUL-joined material, sha256 hex digest).
function computePromptHash({ templateVersion, playbookContent, toolSchemaJson, modelId }) {
  const material = [templateVersion, playbookContent, toolSchemaJson, modelId].join('\u0000');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Minimal .env parser — this script runs as a bare `node` CLI (not `pnpm`, no dotenv loader in the
// path), so DATABASE_URL and the token-price knobs are read directly off <repo>/.env. Never logs a
// value; callers must not print anything read from here.
function parseDotEnv(repoRoot) {
  const envPath = path.join(repoRoot, '.env');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch (err) {
    throw new Error(
      `ab-cells: could not read ${envPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const map = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

// Fallback for DATABASE_URL: this repo's checked-in `.env` does not define it (verified —
// docker-compose.yml is the only place it's wired, for the app CONTAINER's own network). Host-side
// scripts are otherwise expected to export it manually (see scripts/playbook-promote.mjs's own
// "no default" refusal) — rather than guess credentials, this reads the SAME
// `DATABASE_URL: postgres://...@postgres:5432/...` line docker-compose.yml already declares for
// the `app` service and rewrites the compose-network hostname `postgres` to `localhost` (the
// published port-5432 mapping), since this script runs on the host, not inside the compose
// network. Never used when .env (or the real environment) already supplies DATABASE_URL.
function fallbackDatabaseUrlFromCompose(repoRoot) {
  const composePath = path.join(repoRoot, 'docker-compose.yml');
  let text;
  try {
    text = readFileSync(composePath, 'utf8');
  } catch {
    return undefined;
  }
  const match = text.match(/DATABASE_URL:\s*(\S+)/);
  if (!match) return undefined;
  return match[1].replace('@postgres:', '@localhost:');
}

async function fetchDecisions(pool, sinceDate) {
  const { rows } = await pool.query(
    `SELECT id, strategy_id, symbol, model, action, event_time, prompt_hash, playbook_version,
            input_payload, plan_json, input_tokens, output_tokens, cache_read_input_tokens,
            cache_creation_input_tokens, created_at
     FROM agent_decisions
     WHERE created_at >= $1
     ORDER BY created_at ASC`,
    [sinceDate],
  );
  return rows.map((r) => ({
    id: r.id,
    strategyId: r.strategy_id,
    symbol: r.symbol,
    model: r.model,
    action: r.action,
    eventTime: Number(r.event_time),
    promptHash: r.prompt_hash,
    playbookVersion: r.playbook_version,
    blocks: payloadBlocks(r.input_payload),
    planJson: r.plan_json,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    cacheCreationInputTokens: r.cache_creation_input_tokens,
    createdAt: r.created_at,
  }));
}

function payloadBlocks(inputPayloadText) {
  const none = {
    derivatives: false,
    crossSymbol: false,
    tradeFlow: false,
    positioning: false,
    sentiment: false,
  };
  if (!inputPayloadText) return none;
  let parsed;
  try {
    parsed = JSON.parse(inputPayloadText);
  } catch {
    return none;
  }
  return {
    derivatives: parsed.derivatives !== undefined,
    crossSymbol: parsed.crossSymbol !== undefined,
    tradeFlow: parsed.tradeFlow !== undefined,
    positioning: parsed.positioning !== undefined,
    sentiment: parsed.sentiment !== undefined,
  };
}

async function fetchPlaybookVersions(pool) {
  const { rows } = await pool.query('SELECT version, content FROM agent_playbook_versions');
  return new Map(rows.map((r) => [r.version, r.content]));
}

async function fetchEntryIntents(pool, sinceMs) {
  const { rows } = await pool.query(
    `SELECT intent_id, strategy_id, symbol, source_event_time
     FROM order_intents
     WHERE side = 'BUY' AND created_at >= $1::bigint`,
    [sinceMs],
  );
  // Keyed by (strategyId, symbol, sourceEventTime) — the same triple a 'long' decide row's Signal
  // carries (agentic.strategy.ts stamps eventTime/strategyId/symbol onto every emitted Signal).
  const map = new Map();
  for (const r of rows) {
    const key = `${r.strategy_id}\u0000${r.symbol}\u0000${Number(r.source_event_time)}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(r.intent_id);
    else map.set(key, [r.intent_id]);
  }
  return map;
}

async function fetchFills(pool, strategyIds) {
  if (strategyIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT f.symbol, f.qty, f.price, f.fee_amount, f.fee_ccy, f.venue_timestamp, f.intent_id,
            f.fill_id, oi.strategy_id, oi.side
     FROM fills f
     LEFT JOIN order_intents oi ON f.intent_id = oi.intent_id
     WHERE oi.strategy_id = ANY($1::text[])
     ORDER BY f.venue_timestamp ASC, f.fill_id ASC`,
    [strategyIds],
  );
  return rows.map((r) => ({
    strategyId: r.strategy_id,
    symbol: r.symbol,
    side: r.side,
    qty: r.qty,
    price: r.price,
    fee: r.fee_amount,
    feeAsset: r.fee_ccy,
    executedAt: Number(r.venue_timestamp),
    intentId: r.intent_id,
  }));
}

function baseAssetOf(symbol) {
  return symbol.split('/')[0];
}
function quoteAssetOf(symbol) {
  const quotePart = symbol.split('/')[1] ?? '';
  const colonIdx = quotePart.indexOf(':');
  return colonIdx === -1 ? quotePart : quotePart.slice(0, colonIdx);
}

// Simplified port of domain/risk/round-trips.ts's walkRoundTrips (no slippage evidence needed
// here — this tool never renders meanSlippageBps). Same closure rule: a cycle closes when residual
// position notional drops below dustNotional; unconvertible-asset fees are dropped (not summed),
// mirroring that module's documented fail-closed convention rather than silently guessing a price.
function walkRoundTrips(fills, dustNotional) {
  const groups = new Map();
  for (const f of fills) {
    if (f.strategyId === null || f.side === null) continue;
    const key = `${f.strategyId}\u0000${f.symbol}`;
    let g = groups.get(key);
    if (!g) {
      g = { strategyId: f.strategyId, symbol: f.symbol, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(f);
  }

  const cycles = [];
  for (const { strategyId, symbol, rows } of groups.values()) {
    let signedQty = new Decimal(0);
    let cost = new Decimal(0);
    let proceeds = new Decimal(0);
    let boughtQty = new Decimal(0);
    let feesQuote = new Decimal(0);
    let openedAt = null;
    let openingIntentId = null;

    for (const fill of rows) {
      const qty = new Decimal(fill.qty);
      const price = new Decimal(fill.price);
      const notional = qty.mul(price);
      if (openedAt === null) {
        openedAt = fill.executedAt;
        openingIntentId = fill.intentId;
      }
      if (fill.side === 'BUY') {
        signedQty = signedQty.plus(qty);
        cost = cost.plus(notional);
        boughtQty = boughtQty.plus(qty);
      } else {
        signedQty = signedQty.minus(qty);
        proceeds = proceeds.plus(notional);
      }
      if (fill.fee !== null && fill.feeAsset !== null) {
        if (fill.feeAsset === baseAssetOf(symbol)) {
          feesQuote = feesQuote.plus(new Decimal(fill.fee).mul(price));
        } else if (fill.feeAsset === quoteAssetOf(symbol)) {
          feesQuote = feesQuote.plus(new Decimal(fill.fee));
        }
      }

      const residualNotional = signedQty.abs().mul(price);
      if (residualNotional.lt(dustNotional)) {
        cycles.push({
          strategyId,
          symbol,
          realizedPnl: proceeds.minus(cost),
          feesQuote,
          entryNotional: boughtQty.gt(0) ? cost : null,
          openingIntentId,
        });
        signedQty = new Decimal(0);
        cost = new Decimal(0);
        proceeds = new Decimal(0);
        boughtQty = new Decimal(0);
        feesQuote = new Decimal(0);
        openedAt = null;
        openingIntentId = null;
      }
    }
  }
  return cycles;
}

// Rate resolution mirrors promotion-readiness.service.ts's ratesFor, minus its "most-expensive
// pooled fallback for an unmapped model" edge case (this is a diagnostic, not the live-arming
// gate) — an unmapped model simply takes the flat AGENTIC_TOKEN_PRICE_*_PER_MTOK defaults.
function buildRateResolver(env) {
  const defaults = {
    input: new Decimal(env.get('AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK') ?? '3'),
    output: new Decimal(env.get('AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK') ?? '15'),
    cacheRead: new Decimal(env.get('AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK') ?? '0.3'),
    cacheWrite: new Decimal(env.get('AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK') ?? '6'),
  };
  let perModel = {};
  const json = env.get('AGENTIC_TOKEN_PRICES_JSON');
  if (json) {
    try {
      perModel = JSON.parse(json);
    } catch {
      perModel = {};
    }
  }
  return (model) => {
    const entry = perModel[model];
    if (!entry) return defaults;
    return {
      input: new Decimal(entry.inputPerMtok),
      output: new Decimal(entry.outputPerMtok),
      cacheRead: new Decimal(entry.cacheReadPerMtok),
      cacheWrite: new Decimal(entry.cacheWritePerMtok),
    };
  };
}

function rowCost(row, ratesFor) {
  const r = ratesFor(row.model);
  return new Decimal(row.inputTokens ?? 0)
    .div(MTOK)
    .mul(r.input)
    .plus(new Decimal(row.outputTokens ?? 0).div(MTOK).mul(r.output))
    .plus(new Decimal(row.cacheReadInputTokens ?? 0).div(MTOK).mul(r.cacheRead))
    .plus(new Decimal(row.cacheCreationInputTokens ?? 0).div(MTOK).mul(r.cacheWrite));
}

function groupByPromptHash(rows) {
  const map = new Map();
  for (const r of rows) {
    let g = map.get(r.promptHash);
    if (!g) {
      g = { promptHash: r.promptHash, rows: [] };
      map.set(r.promptHash, g);
    }
    g.rows.push(r);
  }
  return [...map.values()];
}

function classifyGroups(groups, playbookMap) {
  const anomalousShort = groups.some((g) => g.rows.some((r) => r.action === 'short'));
  const planModeGlobal = groups.some((g) => g.rows.some((r) => r.planJson !== null));

  for (const g of groups) {
    g.hasDerivatives = g.rows.some((r) => r.blocks.derivatives);
    g.hasCrossSymbol = g.rows.some((r) => r.blocks.crossSymbol);
    g.hasTradeFlow = g.rows.some((r) => r.blocks.tradeFlow);
    g.hasPositioning = g.rows.some((r) => r.blocks.positioning);
    g.infoArm =
      g.hasDerivatives || g.hasCrossSymbol || g.hasTradeFlow || g.hasPositioning
        ? 'treatment'
        : 'control';
  }

  const baseTemplateVersion = planModeGlobal ? BASE_TEMPLATE_PLAN : BASE_TEMPLATE_LEGACY;
  const toolSchemaJson = JSON.stringify(planModeGlobal ? PLAN_TOOL : DECISION_TOOL);

  for (const g of groups) {
    if (anomalousShort) {
      g.thinkingArm = 'UNKNOWN';
      g.thinkingUnknownReason = 'a short action was observed — shorts-tool assumption refused';
      continue;
    }
    // Per-GROUP block presence, not a whole-window "feed enabled" flag: the info-context bundle
    // rolled out incrementally within a single day (derivatives+crossSymbol landed before
    // tradeFlow+positioning — see this file's header comment), so a global "ever seen anywhere in
    // the window" flag would wrongly inject a later feed's tag onto an earlier group's candidate
    // template. Within one prompt_hash group the template is constant by construction, so if ANY
    // row in THIS group ever rendered a block, that tag was in THIS group's template — and if none
    // ever did, the tag was absent (config-disabled or control-arm-stripped; either way, absent).
    const tags = [
      ...(g.hasDerivatives ? [TAG_DERIVATIVES] : []),
      ...(g.rows.some((r) => r.blocks.sentiment) ? [TAG_SENTIMENT] : []),
      ...(g.hasCrossSymbol ? [TAG_CROSS_SYMBOL] : []),
      ...(g.hasTradeFlow ? [TAG_TRADEFLOW] : []),
      ...(g.hasPositioning ? [TAG_POSITIONING] : []),
    ];
    const templateNoTh = tags.length
      ? `${baseTemplateVersion}+${tags.join('+')}`
      : baseTemplateVersion;
    const templateWithTh = `${baseTemplateVersion}+${[...tags, TAG_THINKING].join('+')}`;

    const rep = g.rows[0];
    let playbookContent = '';
    if (rep.playbookVersion !== null) {
      const content = playbookMap.get(rep.playbookVersion);
      if (content === undefined) {
        g.thinkingArm = 'UNKNOWN';
        g.thinkingUnknownReason = `playbook_version ${rep.playbookVersion} not found in agent_playbook_versions`;
        continue;
      }
      playbookContent = content;
    }

    const hashNoTh = computePromptHash({
      templateVersion: templateNoTh,
      playbookContent,
      toolSchemaJson,
      modelId: rep.model,
    });
    const hashWithTh = computePromptHash({
      templateVersion: templateWithTh,
      playbookContent,
      toolSchemaJson,
      modelId: rep.model,
    });
    if (g.promptHash === hashNoTh) {
      g.thinkingArm = 'off';
    } else if (g.promptHash === hashWithTh) {
      g.thinkingArm = 'on';
    } else {
      g.thinkingArm = 'UNKNOWN';
      g.thinkingUnknownReason = 'observed hash matched neither forward-computed candidate';
    }
  }
}

function emptyCell() {
  return {
    decideCount: 0,
    proposeCount: 0,
    trips: 0,
    grossPnl: new Decimal(0),
    fees: new Decimal(0),
    llmCost: new Decimal(0),
    notional: new Decimal(0),
  };
}

async function main() {
  const sinceIso = arg('--since', '2026-07-13T00:00:00Z');
  const sinceDate = new Date(sinceIso);
  if (Number.isNaN(sinceDate.getTime())) {
    console.error(`ab-cells: invalid --since value ${JSON.stringify(sinceIso)}`);
    process.exitCode = 1;
    return;
  }
  const sinceMs = sinceDate.getTime();

  const env = parseDotEnv(REPO_ROOT);
  const databaseUrl = env.get('DATABASE_URL') ?? fallbackDatabaseUrlFromCompose(REPO_ROOT);
  if (!databaseUrl) {
    console.error(
      `ab-cells: DATABASE_URL not found in ${path.join(REPO_ROOT, '.env')} and no fallback ` +
        'could be read from docker-compose.yml',
    );
    process.exitCode = 1;
    return;
  }
  const ratesFor = buildRateResolver(env);
  const dustNotional = new Decimal(env.get('PROMOTION_DUST_NOTIONAL') ?? DUST_NOTIONAL_DEFAULT);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const [decisions, playbookMap, entryIntents] = await Promise.all([
      fetchDecisions(pool, sinceDate),
      fetchPlaybookVersions(pool),
      fetchEntryIntents(pool, sinceMs),
    ]);

    const strategyIds = [...new Set(decisions.map((r) => r.strategyId))];
    const fills = await fetchFills(pool, strategyIds);
    const cycles = walkRoundTrips(fills, dustNotional);

    // Rows that never called an LLM at all — the quiet-HOLD prescreen gate (model='prescreen') and
    // the deterministic plan-executor's own between-consult management rows (model='plan-executor')
    // both journal with prompt_hash='' (counterfactual-scoring.ts's own header comment documents
    // the prescreen convention; plan-executor mirrors it). Neither arm applies to a call that never
    // reached Anthropic, so these are excluded from every cell rather than pooled into one
    // meaningless "empty hash" bucket — reported as a separate count instead.
    const NON_LLM_MODELS = new Set(['prescreen', 'plan-executor']);
    const llmDecisions = decisions.filter(
      (r) => r.promptHash !== '' && !NON_LLM_MODELS.has(r.model),
    );
    const nonLlmCount = decisions.length - llmDecisions.length;

    const groups = groupByPromptHash(llmDecisions);
    classifyGroups(groups, playbookMap);

    // intentId -> owning group's promptHash, for closed-trip attribution below. Only 'long' rows
    // ever open a position, so only they are looked up against the entry-intents map.
    const intentIdToPromptHash = new Map();
    for (const g of groups) {
      for (const row of g.rows) {
        if (row.action !== 'long') continue;
        const key = `${row.strategyId}\u0000${row.symbol}\u0000${row.eventTime}`;
        const intentIds = entryIntents.get(key);
        if (!intentIds) continue;
        for (const intentId of intentIds) intentIdToPromptHash.set(intentId, g.promptHash);
      }
    }

    const anyUnknownThinking = groups.some((g) => g.rows.length > 0 && g.thinkingArm === 'UNKNOWN');

    // Cell key: 'info|thinking' in the full 2x2, or just 'info' in the 2x1 degrade.
    const cellKeyFor = (g) => (anyUnknownThinking ? g.infoArm : `${g.infoArm}|${g.thinkingArm}`);

    const cells = new Map();
    const cellKeyForGroup = new Map();
    for (const g of groups) {
      const key = cellKeyFor(g);
      cellKeyForGroup.set(g.promptHash, key);
      const cell = cells.get(key) ?? emptyCell();
      cell.decideCount += g.rows.length;
      cell.proposeCount += g.rows.filter((r) => r.action === 'long').length;
      for (const row of g.rows) cell.llmCost = cell.llmCost.plus(rowCost(row, ratesFor));
      cells.set(key, cell);
    }

    for (const cycle of cycles) {
      if (cycle.openingIntentId === null) continue;
      const promptHash = intentIdToPromptHash.get(cycle.openingIntentId);
      if (promptHash === undefined) continue;
      const key = cellKeyForGroup.get(promptHash);
      if (key === undefined) continue;
      const cell = cells.get(key);
      if (!cell) continue;
      cell.trips += 1;
      cell.grossPnl = cell.grossPnl.plus(cycle.realizedPnl);
      cell.fees = cell.fees.plus(cycle.feesQuote);
      if (cycle.entryNotional) cell.notional = cell.notional.plus(cycle.entryNotional);
    }

    const rowOrder = anyUnknownThinking
      ? ['treatment', 'control']
      : ['treatment|on', 'treatment|off', 'control|on', 'control|off'];

    // eslint-disable-next-line no-console
    console.log(
      `ab-cells: since=${sinceIso} decisions=${decisions.length} (excluding ${nonLlmCount} non-LLM ` +
        `prescreen/plan-executor rows) llmDecisions=${llmDecisions.length} distinct prompt_hash groups=${groups.length}`,
    );
    if (anyUnknownThinking) {
      // eslint-disable-next-line no-console
      console.log(
        '\nthinking-arm inference was AMBIGUOUS for at least one prompt_hash group — printing the' +
          ' 2x1 info-context table only. See the per-group notes below for why.',
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n=== CELL TABLE ===');
    for (const key of rowOrder) {
      const cell = cells.get(key) ?? emptyCell();
      const netUsd = cell.grossPnl.minus(cell.fees).minus(cell.llmCost);
      const netBpsPerTrip = cell.notional.gt(0)
        ? netUsd.div(cell.notional).mul(10_000).toFixed(2)
        : 'n/a';
      const proposeRate = cell.decideCount > 0 ? cell.proposeCount / cell.decideCount : null;
      const abstainRate = proposeRate === null ? null : 1 - proposeRate;
      const costPerDecide =
        cell.decideCount > 0 ? cell.llmCost.div(cell.decideCount).toFixed(6) : 'n/a';
      // eslint-disable-next-line no-console
      console.log(
        `  [${key}] decide=${cell.decideCount} propose=${cell.proposeCount} trips=${cell.trips} ` +
          `grossPnl=${cell.grossPnl.toFixed(2)} fees=${cell.fees.toFixed(2)} ` +
          `llmCost=${cell.llmCost.toFixed(6)} netUsd=${netUsd.toFixed(2)} netBps/trip=${netBpsPerTrip} ` +
          `proposeRate=${proposeRate === null ? 'n/a' : (proposeRate * 100).toFixed(1) + '%'} ` +
          `abstainRate=${abstainRate === null ? 'n/a' : (abstainRate * 100).toFixed(1) + '%'} ` +
          `cost/decide=${costPerDecide}`,
      );
    }

    if (anyUnknownThinking) {
      // eslint-disable-next-line no-console
      console.log('\n=== UNKNOWN-THINKING GROUPS (prompt_hash, rows, reason) ===');
      for (const g of groups) {
        if (g.thinkingArm !== 'UNKNOWN' || g.rows.length === 0) continue;
        // eslint-disable-next-line no-console
        console.log(
          `  ${g.promptHash.slice(0, 12)}... rows=${g.rows.length} reason=${g.thinkingUnknownReason}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`ab-cells: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
