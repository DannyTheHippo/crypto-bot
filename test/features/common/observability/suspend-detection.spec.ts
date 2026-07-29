import { Test, type TestingModule } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { register } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppConfigModule } from '../../../../src/config/config.module';
import { ObservabilityModule } from '../../../../src/features/common/observability/observability.module';

// Replaces the retired collector daemon's `pmset -g ps` / `sysctl kern.boottime` / `uptime` probes.
// Those described the HOST from outside; this describes the process that was actually frozen. When
// the MacBook sleeps, the Docker VM freezes with it — wall time resyncs on wake while the monotonic
// clock does not, so the divergence across one 5s tick IS the suspend.
//
// vi.setSystemTime moves the faked wall clock without advancing the faked monotonic clock, which is
// exactly the shape a real suspend presents.
describe('MetricsService suspend detection', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    // 'performance' must be faked explicitly: vitest's default toFake advances Date but leaves
    // performance.now() on the real clock, which would report a full tick of skew every tick and
    // invert the very relationship under test.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, ObservabilityModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
  });

  // The monotonic side cannot be faked here: metrics.service.ts imports `performance` from
  // perf_hooks, and sinon only replaces globalThis.performance — so the baseline in this suite is
  // one tick of REAL elapsed time rather than the ~0 production reads with both clocks live.
  // Asserting an exact zero would be asserting an artifact of the harness; the contract under test
  // is the threshold decision, which holds either way.
  const SUSPEND_THRESHOLD_SECONDS = 120;

  async function skewSeconds(): Promise<number> {
    const exposition = await register.getSingleMetricAsString('app_wall_clock_skew_seconds');
    const match = /app_wall_clock_skew_seconds (-?[\d.e+-]+)/.exec(exposition);
    if (!match?.[1]) throw new Error(`no app_wall_clock_skew_seconds sample in:\n${exposition}`);
    return new Decimal(match[1]).toNumber();
  }

  it('stays well under the suspend threshold and counts nothing on an ordinary tick', async () => {
    vi.advanceTimersByTime(5000);

    expect(await skewSeconds()).toBeLessThan(SUSPEND_THRESHOLD_SECONDS);

    const suspends = await register.getSingleMetricAsString('app_suspend_events_total');
    expect(suspends).toContain('app_suspend_events_total 0');
  });

  it('counts a suspend when wall time jumps while the monotonic clock does not', async () => {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    vi.setSystemTime(new Date(Date.now() + sixHoursMs));
    vi.advanceTimersByTime(5000);

    // 6h of wall advance against one tick of monotonic advance — the suspend duration itself.
    expect(await skewSeconds()).toBeGreaterThan(21_000);

    const suspends = await register.getSingleMetricAsString('app_suspend_events_total');
    expect(suspends).toContain('app_suspend_events_total 1');
  });

  it('drops back below the threshold on the next tick — the gauge is per-tick, not cumulative', async () => {
    vi.advanceTimersByTime(5000);

    expect(await skewSeconds()).toBeLessThan(SUSPEND_THRESHOLD_SECONDS);

    const suspends = await register.getSingleMetricAsString('app_suspend_events_total');
    expect(suspends).toContain('app_suspend_events_total 1');
  });

  it('exports build_info with the git sha the image was built from', async () => {
    const buildInfo = await register.getSingleMetricAsString('build_info');
    // No GIT_SHA build arg under test — the documented degrade, never a boot failure.
    expect(buildInfo).toContain('git_sha="unknown"} 1');
  });
});
