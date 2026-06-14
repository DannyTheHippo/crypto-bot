CREATE TABLE "audit_log" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"category" text NOT NULL,
	"payload" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "balances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"venue" text NOT NULL,
	"asset" text NOT NULL,
	"free" numeric(38, 18) NOT NULL,
	"locked" numeric(38, 18) NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_snapshots" (
	"hash" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_curve" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "equity_curve_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity" numeric(38, 18) NOT NULL,
	"cash" numeric(38, 18) NOT NULL,
	"unrealized" numeric(38, 18) NOT NULL,
	"peak" numeric(38, 18) NOT NULL,
	"session_date_utc" text NOT NULL,
	"gap_annotation" text,
	"boot_id" text NOT NULL,
	"mode" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exec_outbox" (
	"cursor" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "exec_outbox_cursor_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"report_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exec_outbox_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
CREATE TABLE "fee_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fee_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"venue" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"fill_id" bigint,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"fill_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fills_fill_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"venue_trade_id" text NOT NULL,
	"intent_id" text,
	"client_order_id" text NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"fee_ccy" text,
	"fee_amount" numeric(38, 18),
	"fee_resolved" boolean DEFAULT false NOT NULL,
	"liquidity" text NOT NULL,
	"venue_timestamp" bigint NOT NULL,
	"source" text NOT NULL,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mode_transitions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mode_transitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"from_mode" text NOT NULL,
	"to_mode" text NOT NULL,
	"actor" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"boot_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"seq" bigint NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_intents" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"client_order_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"limit_price" numeric(38, 18),
	"time_in_force" text NOT NULL,
	"reduce_only" boolean NOT NULL,
	"ref_price" numeric(38, 18) NOT NULL,
	"ref_seq" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"source_dedupe_key" text NOT NULL,
	"source_event_time" bigint NOT NULL,
	"source_based_on_seq" bigint NOT NULL,
	"source_strength" text NOT NULL,
	"signal_id" text,
	"risk_intent_hash" text,
	"risk_hmac" text,
	"risk_nonce" text,
	"risk_approved_at_ms" bigint,
	"risk_limits_version" text,
	"risk_snapshot_seq" bigint,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"created_at_wall" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_intents_client_order_id_unique" UNIQUE("client_order_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"client_order_id" text NOT NULL,
	"venue_order_id" text,
	"strategy_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"limit_price" numeric(38, 18),
	"time_in_force" text NOT NULL,
	"state" text NOT NULL,
	"cum_qty" numeric(38, 18) NOT NULL,
	"submitted_at" bigint,
	"acked_at" bigint,
	"first_fill_at" bigint,
	"terminal_at" bigint,
	"raw_ack" jsonb,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_client_order_id_unique" UNIQUE("client_order_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_consumer_acks" (
	"consumer_id" text NOT NULL,
	"cursor" bigint NOT NULL,
	"acked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_consumer_acks_consumer_id_pk" PRIMARY KEY("consumer_id")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"strategy_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"signed_qty" numeric(38, 18) NOT NULL,
	"avg_entry" numeric(38, 18) NOT NULL,
	"realized_pnl" numeric(38, 18) NOT NULL,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_mode_strategy_id_venue_symbol_pk" PRIMARY KEY("mode","strategy_id","venue","symbol")
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reconciliations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL,
	"open_orders_checked" integer NOT NULL,
	"trades_checked" integer NOT NULL,
	"balances_checked" integer NOT NULL,
	"discrepancies" jsonb NOT NULL,
	"result" text NOT NULL,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "risk_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"intent_id" text NOT NULL,
	"verdict" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"limits_version" text NOT NULL,
	"snapshot_seq" bigint NOT NULL,
	"inputs_hash" text NOT NULL,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"signal_id" text PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"strength" text NOT NULL,
	"limit_price_hint" numeric(38, 18),
	"ref_price" numeric(38, 18) NOT NULL,
	"based_on_seq" bigint NOT NULL,
	"event_time" bigint NOT NULL,
	"ttl_ms" integer NOT NULL,
	"dedupe_key" text NOT NULL,
	"reason" text NOT NULL,
	"outcome" text NOT NULL,
	"intent_id" text,
	"mode" text NOT NULL,
	"run_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_fill_id_fills_fill_id_fk" FOREIGN KEY ("fill_id") REFERENCES "public"."fills"("fill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_intent_id_order_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_intent_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_intent_id_order_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_intent_id_order_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_intent_id_order_intents_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "equity_curve_run_ts_uidx" ON "equity_curve" USING btree ("run_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_venue_symbol_trade_uidx" ON "fills" USING btree ("venue","symbol","venue_trade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_order_dedupe_uidx" ON "order_events" USING btree ("order_id","dedupe_key");
