import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { LoggerModule } from 'nestjs-pino';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { HealthController } from './health.controller';
import { EventLoopHealthIndicator } from './event-loop-health.indicator';
import {
  MetricsService,
  EVENT_LOOP_DELAY_GAUGE,
  EVENT_LOOP_UTILIZATION_GAUGE,
  MODE_INFO_GAUGE,
  BOOT_INFO_GAUGE,
  KILL_SWITCH_STATE_GAUGE,
  EQUITY_GAUGE,
  CASH_GAUGE,
  PEAK_EQUITY_GAUGE,
  DAY_PNL_GAUGE,
  DRAWDOWN_GAUGE,
  UNREALIZED_PNL_GAUGE,
  STARTING_CASH_GAUGE,
  REALIZED_PNL_GAUGE,
  POSITION_QTY_GAUGE,
  POSITION_NOTIONAL_GAUGE,
  OPEN_ORDERS_GAUGE,
  IN_FLIGHT_GAUGE,
  STRATEGY_LIFECYCLE_GAUGE,
  AGENT_DECIDE_COUNTER,
  AGENT_TOKENS_COUNTER,
  AGENT_DECIDE_LATENCY_HISTOGRAM,
  AGENTIC_PLAYBOOK_INFO_GAUGE,
  PLAYBOOK_VALIDATOR_REJECTIONS_COUNTER,
  AGENT_CLIENT_INFO_GAUGE,
  AGENTIC_PRESCREEN_COUNTER,
  AGENTIC_REFLECTION_OUTCOMES_COUNTER,
  AGENTIC_VENUE_TP_COUNTER,
  AGENTIC_VENUE_STOP_COUNTER,
  DERIVATIVES_FEED_STALENESS_GAUGE,
  DERIVATIVES_FEED_POLL_ERRORS_COUNTER,
  SENTIMENT_FEED_STALENESS_GAUGE,
  SENTIMENT_FEED_POLL_ERRORS_COUNTER,
} from './metrics.service';
import { AgentMetricsRecorder } from './agent-metrics-recorder.service';
import {
  PromotionMetricsService,
  PROMOTION_ROUND_TRIPS_GAUGE,
  PROMOTION_NET_PNL_GAUGE,
  PROMOTION_LLM_COST_GAUGE,
  PROMOTION_WINDOW_DAYS_GAUGE,
  PROMOTION_READY_GAUGE,
} from './promotion-metrics.service';
import {
  VersionAttributionMetricsService,
  VERSION_NET_PNL_GAUGE,
  VERSION_ROUND_TRIPS_GAUGE,
} from './version-attribution-metrics.service';
import { buildPinoHttpOptions } from './logger.config';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [TypedConfigService],
      useFactory: (configService: TypedConfigService) => {
        const mode = configService.mode;
        const app = configService.app;
        const obs = configService.observability;
        return buildPinoHttpOptions({
          level: obs.logLevel,
          bootId: app.bootId,
          mode: mode.configMode,
        });
      },
    }),
    TerminusModule,
    PrometheusModule.register({
      defaultMetrics: {
        enabled: true,
      },
    }),
  ],
  controllers: [HealthController],
  providers: [
    EventLoopHealthIndicator,
    MetricsService,
    EVENT_LOOP_DELAY_GAUGE,
    EVENT_LOOP_UTILIZATION_GAUGE,
    MODE_INFO_GAUGE,
    BOOT_INFO_GAUGE,
    KILL_SWITCH_STATE_GAUGE,
    EQUITY_GAUGE,
    CASH_GAUGE,
    PEAK_EQUITY_GAUGE,
    DAY_PNL_GAUGE,
    DRAWDOWN_GAUGE,
    UNREALIZED_PNL_GAUGE,
    STARTING_CASH_GAUGE,
    REALIZED_PNL_GAUGE,
    POSITION_QTY_GAUGE,
    POSITION_NOTIONAL_GAUGE,
    OPEN_ORDERS_GAUGE,
    IN_FLIGHT_GAUGE,
    STRATEGY_LIFECYCLE_GAUGE,
    AGENT_DECIDE_COUNTER,
    AGENT_TOKENS_COUNTER,
    AGENT_DECIDE_LATENCY_HISTOGRAM,
    AGENTIC_PLAYBOOK_INFO_GAUGE,
    PLAYBOOK_VALIDATOR_REJECTIONS_COUNTER,
    AGENT_CLIENT_INFO_GAUGE,
    AGENTIC_PRESCREEN_COUNTER,
    AGENTIC_REFLECTION_OUTCOMES_COUNTER,
    AGENTIC_VENUE_TP_COUNTER,
    AGENTIC_VENUE_STOP_COUNTER,
    DERIVATIVES_FEED_STALENESS_GAUGE,
    DERIVATIVES_FEED_POLL_ERRORS_COUNTER,
    SENTIMENT_FEED_STALENESS_GAUGE,
    SENTIMENT_FEED_POLL_ERRORS_COUNTER,
    AgentMetricsRecorder,
    PROMOTION_ROUND_TRIPS_GAUGE,
    PROMOTION_NET_PNL_GAUGE,
    PROMOTION_LLM_COST_GAUGE,
    PROMOTION_WINDOW_DAYS_GAUGE,
    PROMOTION_READY_GAUGE,
    PromotionMetricsService,
    VERSION_NET_PNL_GAUGE,
    VERSION_ROUND_TRIPS_GAUGE,
    VersionAttributionMetricsService,
  ],
  exports: [EventLoopHealthIndicator, MetricsService, AgentMetricsRecorder],
})
export class ObservabilityModule {}
