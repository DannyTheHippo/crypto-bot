#!/usr/bin/env node
// Deferred arm-ceremony CLI — `pnpm arm` (arming.controller.ts's own header comment defers "the
// CLI wrapper" to runtime glue; this is that glue). Turns the two-step, bootId-bound live-arming
// flow (docs/runbook.md §Re-arm) into one operator command: POST arm/request, compute the HMAC
// proof locally within the 60s challenge TTL (CHALLENGE_TTL_MS, src/domain/mode/arming.ts), POST
// arm/confirm. This script automates ONLY the operator's client-side steps (posting bodies,
// computing the proof, respecting the clock) — every server-side gate (challenge TTL, bootId
// binding to the process's OWN cfg.bootId, constant-time HMAC verify in
// src/features/trading/mode-control/hmac.ts, ARM preconditions, the four live gates in
// src/domain/mode/resolution.ts) lives entirely server-side and is untouched by anything here.

import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://localhost:3100';
// Mirrors src/domain/mode/arming.ts's CHALLENGE_TTL_MS — used here only to warn the operator if
// the round trip to compute+send the proof is eating into the server's own TTL budget; the actual
// enforcement is server-side (reduceArming's CONFIRM branch).
const CHALLENGE_TTL_MS = 60_000;
// /health does not expose bootId (see src/features/common/observability/health.controller.ts) —
// it is exposed as a Prometheus gauge instead (metrics.service.ts's onModuleInit:
// `bootInfoGauge.labels({ boot_id: app.bootId }).set(1)`, registered name 'boot_info'), scraped at
// the unversioned, unprefixed /metrics route (config/app.config.ts).
const BOOT_INFO_RE = /boot_info\{boot_id="([^"]+)"\}/;

function usage() {
  return [
    'usage: pnpm arm [-- --base-url <url>] [-- --boot-id <id>] [-- --disarm]',
    '',
    'Environment:',
    '  ARMING_SECRET             required for ARMING — the HMAC secret. Env only: never a flag, never logged. Not needed for --disarm (the server takes no proof to disarm; an emergency disarm must never block on a missing env var).',
    '  ARMING_TRANSPORT_TOKEN    optional second factor — sent as the x-arming-token header on arm/request + arm/confirm when set. Not needed for --disarm.',
    '  BASE_URL                  optional — default base URL, overridden by --base-url.',
    '',
    'Flags:',
    '  --base-url <url>  API base URL (default http://localhost:3100).',
    '  --boot-id <id>    target process bootId; if omitted, fetched from GET /metrics',
    '                    (the boot_info{boot_id="..."} gauge — /health does not expose bootId).',
    '  --disarm          call POST /api/v1/mode/disarm instead of arming.',
    '  -h, --help        print this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.BASE_URL ?? DEFAULT_BASE_URL,
    bootId: undefined,
    disarm: false,
    help: false,
    error: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') {
      opts.baseUrl = argv[++i];
    } else if (a === '--boot-id') {
      opts.bootId = argv[++i];
    } else if (a === '--disarm') {
      opts.disarm = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else {
      opts.error = `unrecognized argument ${JSON.stringify(a)}`;
    }
  }
  return opts;
}

// Exported for the unit spec: this is the SAME 3-line construction as
// src/features/trading/mode-control/hmac.ts's computeArmingHmac (challengeId + ':' + bootId,
// HMAC-SHA256, hex) — duplicated here rather than imported because this script runs standalone
// via `node`, outside the tsconfig/Nest module graph (see eslint.config.mjs's scripts/** ignore).
export function computeProof(challengeId, bootId, secret) {
  return createHmac('sha256', secret).update(`${challengeId}:${bootId}`).digest('hex');
}

function redactedProof(hex) {
  return `${hex.slice(0, 8)}…(redacted)`;
}

function summarize(body) {
  if (body === undefined || body === '') return '(empty body)';
  if (typeof body === 'string') return body.slice(0, 300);
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

async function fetchBootId(baseUrl) {
  const res = await fetch(`${baseUrl}/metrics`);
  if (!res.ok) {
    throw new Error(`GET /metrics failed: HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const match = BOOT_INFO_RE.exec(text);
  if (!match) {
    throw new Error('boot_info{boot_id="..."} not found in /metrics output');
  }
  return match[1];
}

async function postJson(url, payload, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

// §10b arm-hardening transport guard (ArmingTransportGuard): a second, non-cryptographic factor at
// the HTTP layer, distinct from the HMAC challenge/response above. Sent on arm/request + arm/confirm
// only — disarm is intentionally unguarded server-side (see runDisarm's own comment), so it never
// needs this header. Omitted entirely when unset: the server's guard already passes through when
// ARMING_TRANSPORT_TOKEN is unconfigured outside TRADING_MODE=live.
function armingTransportHeaders() {
  const token = process.env.ARMING_TRANSPORT_TOKEN;
  return token ? { 'x-arming-token': token } : {};
}

async function runDisarm(baseUrl) {
  const res = await postJson(`${baseUrl}/api/v1/mode/disarm`, undefined);
  if (!res.ok) {
    console.error(`arm-ceremony: disarm failed (HTTP ${res.status}): ${summarize(res.body)}`);
    return 1;
  }
  console.log('arm-ceremony: disarmed.');
  return 0;
}

async function runArm(baseUrl, bootIdFlag, secret) {
  let bootId = bootIdFlag;
  if (bootId) {
    console.log(`arm-ceremony: bootId=${bootId} (from --boot-id)`);
  } else {
    try {
      bootId = await fetchBootId(baseUrl);
    } catch (err) {
      console.error(
        `arm-ceremony: could not determine bootId from GET ${baseUrl}/metrics: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error('arm-ceremony: pass --boot-id <id> explicitly instead.');
      return 1;
    }
    console.log(`arm-ceremony: bootId=${bootId} (from GET /metrics)`);
  }

  const requestStartMs = Date.now();
  const requestRes = await postJson(
    `${baseUrl}/api/v1/mode/arm/request`,
    { bootId },
    armingTransportHeaders(),
  );
  if (!requestRes.ok || requestRes.body?.ok !== true || !requestRes.body?.challengeId) {
    console.error(
      `arm-ceremony: arm/request failed (HTTP ${requestRes.status}): ${summarize(requestRes.body)}`,
    );
    return 1;
  }
  const { challengeId } = requestRes.body;
  console.log(`arm-ceremony: arm/request ok — challengeId=${challengeId}`);

  const proof = computeProof(challengeId, bootId, secret);
  console.log(`arm-ceremony: computed proof ${redactedProof(proof)}`);

  const elapsedMs = Date.now() - requestStartMs;
  if (elapsedMs > CHALLENGE_TTL_MS - 5_000) {
    console.error(
      `arm-ceremony: ${elapsedMs}ms elapsed since arm/request — close to the server's 60s challenge TTL; confirming anyway.`,
    );
  }

  const confirmRes = await postJson(
    `${baseUrl}/api/v1/mode/arm/confirm`,
    { challengeId, hmacHex: proof, bootId },
    armingTransportHeaders(),
  );
  if (!confirmRes.ok || confirmRes.body?.ok !== true) {
    console.error(
      `arm-ceremony: arm/confirm failed (HTTP ${confirmRes.status}): ${summarize(confirmRes.body)}`,
    );
    return 1;
  }

  console.log('arm-ceremony: ARMED.');
  return 0;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`arm-ceremony: ${opts.error}`);
    console.error(usage());
    return 1;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  // Disarm is the SAFETY direction (halt live trading) and the server requires no proof for it —
  // never let a missing env var block an emergency disarm.
  if (opts.disarm) {
    return runDisarm(opts.baseUrl);
  }

  const secret = process.env.ARMING_SECRET;
  if (!secret) {
    console.error('arm-ceremony: ARMING_SECRET is required (env only) — refusing to run.');
    return 1;
  }
  return runArm(opts.baseUrl, opts.bootId, secret);
}

// Only auto-run when executed directly (`node scripts/arm-ceremony.mjs` / `pnpm arm`) — importing
// this module (the unit spec imports computeProof) must never trigger a network call.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(
        `arm-ceremony: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
