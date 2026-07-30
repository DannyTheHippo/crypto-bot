import { describe, it, expect, vi } from 'vitest';
import { TradingRuntimeService } from '../../../../src/features/trading/composition/trading-runtime.module';

// Pass 50 (adversarial review, 2026-07-30): seedConfiguredLabelSets is the ONLY call site for
// AgentMetricsRecorder.seedTokenModels/seedVenueTpVenues/seedVenueStopVenues — deleting the whole
// method (or its three calls) from TradingRuntimeService's constructor left the rest of this suite
// green, because no test previously exercised the composition-root wiring itself. Same
// Object.create-prototype harness trading-runtime-log-portfolio.spec.ts establishes: the constructor
// wires the full ~30-collaborator app DI graph and is never direct-constructed in this suite, so this
// stubs only the handful of instance fields seedConfiguredLabelSets itself reads.
interface SeedHarness {
  seedConfiguredLabelSets(): void;
}

function makeHarness(opts: { model?: string; reflectionModel?: string; venueIds?: string[] }): {
  service: SeedHarness;
  seedTokenModels: ReturnType<typeof vi.fn>;
  seedVenueTpVenues: ReturnType<typeof vi.fn>;
  seedVenueStopVenues: ReturnType<typeof vi.fn>;
} {
  const seedTokenModels = vi.fn();
  const seedVenueTpVenues = vi.fn();
  const seedVenueStopVenues = vi.fn();
  const service = Object.create(TradingRuntimeService.prototype) as Record<string, unknown>;
  service['agentMetrics'] = { seedTokenModels, seedVenueTpVenues, seedVenueStopVenues };
  service['config'] = {
    agentic: { model: opts.model ?? 'claude-sonnet-5', reflectionModel: opts.reflectionModel },
    venues: (opts.venueIds ?? ['binance', 'binanceusdm']).map((id) => ({ id })),
  };
  return {
    service: service as unknown as SeedHarness,
    seedTokenModels,
    seedVenueTpVenues,
    seedVenueStopVenues,
  };
}

describe('TradingRuntimeService.seedConfiguredLabelSets', () => {
  it('seeds agent_tokens_total models with [decideModel, decideModel] when no reflection override is configured', () => {
    const { service, seedTokenModels } = makeHarness({ model: 'claude-sonnet-5' });
    service.seedConfiguredLabelSets();
    expect(seedTokenModels).toHaveBeenCalledWith(['claude-sonnet-5', 'claude-sonnet-5']);
  });

  it('seeds agent_tokens_total models with [decideModel, reflectionModel] when AGENTIC_REFLECTION_MODEL is configured', () => {
    const { service, seedTokenModels } = makeHarness({
      model: 'claude-sonnet-5',
      reflectionModel: 'claude-opus-5',
    });
    service.seedConfiguredLabelSets();
    expect(seedTokenModels).toHaveBeenCalledWith(['claude-sonnet-5', 'claude-opus-5']);
  });

  it('seeds agentic_venue_tp_total and agentic_venue_stop_total with the configured venue ids', () => {
    const { service, seedVenueTpVenues, seedVenueStopVenues } = makeHarness({
      venueIds: ['binance', 'binanceusdm'],
    });
    service.seedConfiguredLabelSets();
    expect(seedVenueTpVenues).toHaveBeenCalledWith(['binance', 'binanceusdm']);
    expect(seedVenueStopVenues).toHaveBeenCalledWith(['binance', 'binanceusdm']);
  });
});
