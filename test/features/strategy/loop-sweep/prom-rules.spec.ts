import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — loop-sweep.mjs is a stdlib-only .mjs with no declaration file. Same bridge as
// alarms.spec.ts uses for the pure core.
import * as sweepModule from '../../../../scripts/loop-sweep.mjs';

// parsePromRules is the SOLE decider of whether an empty firing list is evidence or a negative-read
// void (§C.9), and with no Alertmanager in this stack it is the single point of failure for the whole
// alert-consumption chain. It was shipped untested on 2026-07-28 and its own review said so: the
// core-level test exercised the generic probe-failure loop off a hand-written fixture, not this
// function's decisions. These cases run against captured /api/v1/rules payload shapes.

interface FiringAlert {
  alertname: string;
  severity: string;
  activeAt: string | null;
  summary: string;
}
type ProbeResult =
  | { ok: true; value: { ruleCount: number; alertingCount: number; firing: FiringAlert[] } }
  | { ok: false; error: string };
interface SweepModule {
  parsePromRules: (
    res: { ok: boolean; value?: string; error?: string },
    opts?: { expectedAlertNames?: string[] | null; nowMs?: number | null },
  ) => ProbeResult;
  readExpectedAlertNames: (path: string) => string[] | null;
  RULE_EVAL_STALE_FACTOR: number;
}
const { parsePromRules, readExpectedAlertNames, RULE_EVAL_STALE_FACTOR } =
  sweepModule as unknown as SweepModule;

const NOW = Date.parse('2026-07-28T00:30:00Z');
const FRESH_EVAL = '2026-07-28T00:29:30Z';

function rulesBody(
  rules: Record<string, unknown>[],
  opts: { groupName?: string; interval?: number; lastEvaluation?: string } = {},
): { ok: true; value: string } {
  return {
    ok: true,
    value: JSON.stringify({
      status: 'success',
      data: {
        groups: [
          {
            name: opts.groupName ?? 'crypto-bot-agentic',
            file: '/etc/prometheus/alerts.rules.yml',
            interval: opts.interval ?? 60,
            lastEvaluation: opts.lastEvaluation ?? FRESH_EVAL,
            rules,
          },
        ],
      },
    }),
  };
}

function alertingRule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'alerting',
    name: 'SomeAlert',
    state: 'inactive',
    health: 'ok',
    labels: { severity: 'warning' },
    annotations: { summary: 'a summary' },
    alerts: [],
    ...over,
  };
}

describe('parsePromRules', () => {
  it('reads a firing rule, one entry per firing instance, carrying severity and activeAt', () => {
    const res = parsePromRules(
      rulesBody([
        alertingRule({
          name: 'AgentClientFatalLatch',
          state: 'firing',
          labels: { severity: 'critical' },
          annotations: { summary: 'lane latched' },
          alerts: [
            {
              state: 'firing',
              activeAt: '2026-07-27T21:16:25Z',
              labels: { alertname: 'AgentClientFatalLatch', severity: 'critical' },
            },
          ],
        }),
        // Per-venue rules fire once per label set — both instances must survive.
        alertingRule({
          name: 'ReconciliationHalt',
          state: 'firing',
          labels: { severity: 'critical' },
          alerts: [
            {
              state: 'firing',
              activeAt: '2026-07-27T22:00:00Z',
              labels: { alertname: 'ReconciliationHalt', severity: 'critical', venue: 'binance' },
            },
            {
              state: 'firing',
              activeAt: '2026-07-27T22:01:00Z',
              labels: {
                alertname: 'ReconciliationHalt',
                severity: 'critical',
                venue: 'binanceusdm',
              },
            },
          ],
        }),
      ]),
      { nowMs: NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.alertingCount).toBe(2);
    expect(res.value.firing).toHaveLength(3);
    expect(res.value.firing[0]).toMatchObject({
      alertname: 'AgentClientFatalLatch',
      severity: 'critical',
      activeAt: '2026-07-27T21:16:25Z',
      summary: 'lane latched',
    });
  });

  it('a firing rule with an empty alerts[] still yields one entry — a firing rule can never read as silent', () => {
    const res = parsePromRules(
      rulesBody([
        alertingRule({
          name: 'Odd',
          state: 'firing',
          labels: { severity: 'critical' },
          alerts: [],
        }),
      ]),
      { nowMs: NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.firing).toHaveLength(1);
    expect(res.value.firing[0]).toMatchObject({ alertname: 'Odd', severity: 'critical' });
    expect(res.value.firing[0]?.activeAt).toBeNull();
  });

  it('reports the transport error unchanged when the read itself failed', () => {
    const res = parsePromRules({ ok: false, error: 'docker exited 1: no such container' });
    expect(res).toEqual({ ok: false, error: 'docker exited 1: no such container' });
  });

  it('fails on a non-JSON body — an HTML error page must never parse as quiet health', () => {
    const res = parsePromRules({ ok: true, value: '<html>502 Bad Gateway</html>' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('unparseable JSON');
  });

  it('fails on an unexpected envelope', () => {
    const res = parsePromRules({ ok: true, value: JSON.stringify({ status: 'error' }) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('unexpected envelope');
  });

  it('fails when zero ALERTING rules are loaded, even if recording rules are present', () => {
    const res = parsePromRules(rulesBody([{ type: 'recording', name: 'job:foo', health: 'ok' }]), {
      nowMs: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('ZERO alerting rules');
  });

  // The 2026-07-28 finding: 16 rules loaded against 20 committed, so the four alerts written the day
  // before to catch a silent lane had never evaluated. A count check passes 16>0; only a NAME check
  // says which are missing.
  it('fails when a committed alert name is not loaded, naming the missing rules (the stale-rules-file defect)', () => {
    const res = parsePromRules(rulesBody([alertingRule({ name: 'OldAlert' })]), {
      expectedAlertNames: ['OldAlert', 'AgenticLaneSilent', 'AgenticBudgetExhausted'],
      nowMs: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('STALE rules file');
    expect(res.error).toContain('AgenticLaneSilent');
    expect(res.error).toContain('AgenticBudgetExhausted');
    expect(res.error).not.toContain('OldAlert,');
  });

  it('passes when every committed alert name is loaded, and tolerates rules loaded beyond the file', () => {
    const res = parsePromRules(
      rulesBody([alertingRule({ name: 'A' }), alertingRule({ name: 'B' })]),
      { expectedAlertNames: ['A'], nowMs: NOW },
    );
    expect(res.ok).toBe(true);
  });

  it('fails on an unhealthy rule — a frozen state is not a current read', () => {
    const res = parsePromRules(
      rulesBody([alertingRule({ name: 'Broken', health: 'err', lastError: 'duplicate series' })]),
      { nowMs: NOW },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('not healthy');
    expect(res.error).toContain('duplicate series');
  });

  it('fails on a rule group that has stopped evaluating', () => {
    const intervalMs = 60_000;
    const res = parsePromRules(
      rulesBody([alertingRule()], {
        interval: 60,
        lastEvaluation: new Date(NOW - (RULE_EVAL_STALE_FACTOR + 1) * intervalMs).toISOString(),
      }),
      { nowMs: NOW },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('stopped evaluating');
  });

  it('does not fire the freshness check without a clock — an unknown age is not asserted either way', () => {
    const res = parsePromRules(
      rulesBody([alertingRule()], { lastEvaluation: '2020-01-01T00:00:00Z' }),
      { nowMs: null },
    );
    expect(res.ok).toBe(true);
  });
});

describe('readExpectedAlertNames', () => {
  it('reads every committed alert name out of the real rules file', () => {
    // Resolved off the vitest root (the repo root) rather than the module URL: this repo's absolute
    // path contains spaces, so URL.pathname would percent-encode into a path readFileSync cannot
    // open, and `import.meta` is not permitted under this tsconfig's module setting.
    const names = readExpectedAlertNames(join(process.cwd(), 'observability', 'alerts.rules.yml'));
    expect(names).not.toBeNull();
    // Pins the control against the live file rather than a fixture: if an alert is added to the file
    // and this list is not the source of the sweep's expectation, the sweep silently stops checking it.
    expect(names).toContain('AgentClientFatalLatch');
    expect(names).toContain('AgenticLaneSilent');
    expect(names).toContain('AgenticBudgetExhausted');
    expect(names).toContain('ReconciliationNeverCleanSustained');
    expect(names).toContain('ReconciliationSweepFailureSustained');
  });

  it('returns null for an unreadable file — the control is SKIPPED, never failed, since a missing local file says nothing about what prometheus loaded', () => {
    expect(readExpectedAlertNames('/nonexistent/alerts.rules.yml')).toBeNull();
  });
});
