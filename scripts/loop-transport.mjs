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

// Container names follow docker compose's `<project>-<service>-N` default (project = crypto-bot):
// spot app/postgres/prometheus = crypto-bot-{app,postgres,prometheus}-1; perp lane appends `-perp`.
// psql goes through `docker compose exec` by SERVICE name; promtool through `docker exec` by CONTAINER.
const PG_SERVICE = { spot: 'postgres', perp: 'postgres-perp' };
const PROM_CONTAINER = { spot: 'crypto-bot-prometheus-1', perp: 'crypto-bot-prometheus-perp-1' };

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

// db selects the lane (spot|perp) -> service name; same user/db (cryptobot/cryptobot) on both lanes.
// -A (unaligned) -t (tuples-only) -c (command) yields raw newline-delimited rows the runner parses.
export function psql(db, sql, opts = {}) {
  const service = PG_SERVICE[db] ?? PG_SERVICE.spot;
  const args = ['compose'];
  if (db === 'perp') args.push('--profile', 'perp');
  args.push('exec', '-T', service, 'psql', '-U', 'cryptobot', '-d', 'cryptobot', '-Atc', sql);
  return run('docker', args, { cwd: opts.cwd });
}

// promtool runs INSIDE the lane's prometheus container against its own localhost:9090.
export function promQuery(expr, lane = 'spot') {
  const container = PROM_CONTAINER[lane] ?? PROM_CONTAINER.spot;
  return run('docker', [
    'exec',
    container,
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
