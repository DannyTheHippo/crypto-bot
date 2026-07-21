#!/usr/bin/env node
// Y2 health-sweep TRANSPORT — the single chokepoint for every read against the running stack. A later
// GCP lift (memory crypto-bot-gcp-migration) re-points ONLY this file: the runner and the pure core
// never spawn a process. Every function returns { ok:true, value } | { ok:false, error } and NEVER
// throws — a probe failure is data the sweep reports (measurement fails OPEN, §D), not an exception
// that aborts the pass.
//
// Read-only by construction: docker ps/inspect/stats/logs, `psql -Atc <select>`, `promtool query
// instant`, and host power/uptime. No `docker logs --since` (§B: it silently voids negative evidence
// across rotation/daemon-restart boundaries — `--tail` only). No `cd` (memory crypto-bot-fnm-node-
// gotcha): the repo directory is passed as spawn `cwd`, which never triggers the shell's fnm hook.

import { spawnSync } from 'node:child_process';

// v3 single stack (docker-compose.yml): exactly 4 containers — crypto-bot-{app,postgres,prometheus,
// grafana}-1, no `-perp` siblings, no compose profile. One process serves both venues (spot binance +
// perp binanceusdm) against the ONE db (cryptobot) and the ONE Prometheus. psql goes through
// `docker compose exec` by SERVICE name; promtool through `docker exec` by CONTAINER.
const PG_SERVICE = 'postgres';
const PROM_CONTAINER = 'crypto-bot-prometheus-1';

// One wrapped spawn: capture stdout+stderr, coerce every failure mode (non-zero exit, spawn error,
// timeout) into { ok:false, error } so no caller ever sees a throw.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    return { ok: false, error: `${cmd}: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').toString().trim();
    const stdout = (res.stdout || '').toString().trim();
    return {
      ok: false,
      error: `${cmd} exited ${res.status ?? 'null'}: ${stderr || stdout || 'no output'}`,
    };
  }
  return { ok: true, value: (res.stdout || '').toString() };
}

export function dockerPs() {
  return run('docker', ['ps', '--no-trunc', '--format', '{{json .}}']);
}

export function dockerInspect(name) {
  return run('docker', ['inspect', name]);
}

export function dockerStats() {
  return run('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
}

// n bounds the tail window — never `--since` (§B negative-read voids across rotation boundaries).
export function dockerLogsTail(container, n) {
  return run('docker', ['logs', '--tail', String(n), container]);
}

// One db (cryptobot/cryptobot), reached via docker compose exec by SERVICE name.
// -A (unaligned) -t (tuples-only) -c (command) yields raw newline-delimited rows the runner parses.
export function psql(sql, opts = {}) {
  const args = [
    'compose',
    'exec',
    '-T',
    PG_SERVICE,
    'psql',
    '-U',
    'cryptobot',
    '-d',
    'cryptobot',
    '-Atc',
    sql,
  ];
  return run('docker', args, { cwd: opts.cwd });
}

// promtool runs INSIDE the one prometheus container against its own localhost:9090. Venue-scoped
// series (market_channel_staleness_seconds, reconciliation_runs_total, venue_free_cash_usdt, ...)
// carry a `venue` label on the SAME series set — callers select venue via the PromQL expr, not by
// picking a different container.
export function promQuery(expr) {
  return run('docker', [
    'exec',
    PROM_CONTAINER,
    'promtool',
    'query',
    'instant',
    'http://localhost:9090',
    expr,
  ]);
}

// Host duty-cycle provenance (§D open-with-host-state): power source, boot time, load. Each sub-read is
// wrapped independently so a missing tool on one axis never voids the others; the aggregate is always ok.
export function hostState() {
  const power = run('pmset', ['-g', 'ps']);
  const boottime = run('sysctl', ['-n', 'kern.boottime']);
  const up = run('uptime', []);
  return {
    ok: true,
    value: {
      powerSource: power.ok ? power.value.trim() : null,
      bootTime: boottime.ok ? boottime.value.trim() : null,
      uptime: up.ok ? up.value.trim() : null,
      errors: [
        ...(power.ok ? [] : [`pmset: ${power.error}`]),
        ...(boottime.ok ? [] : [`sysctl: ${boottime.error}`]),
        ...(up.ok ? [] : [`uptime: ${up.error}`]),
      ],
    },
  };
}
