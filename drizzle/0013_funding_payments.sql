-- funding_payments: venue-reported perp funding-payment settlements (P5b, ccxt fetchFundingHistory).
-- DISTINCT from funding_events (0008): that table is the paper-sim journal written by
-- PaperPerpAdapter.applyFunding and carries fundingRate/markPrice/signedQty — fields ccxt's unified
-- FundingHistory row does not expose. UNIQUE(venue, symbol, venue_payment_id) mirrors fills' own
-- dedupe key; the repository inserts ON CONFLICT DO NOTHING for idempotent re-ingestion.
-- Same two-layer append-only hardening as audit_log/order_events/funding_events (0001/0008):
--   1. REVOKE UPDATE, DELETE, TRUNCATE prevents the application role from mutating rows.
--   2. A BEFORE UPDATE OR DELETE OR TRUNCATE trigger covers the owner (bypasses GRANTs).
-- Reuses raise_audit_immutable() defined in 0001 — one function, shared across every
-- append-only table, no re-declaration here.

CREATE TABLE "funding_payments" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "venue" text NOT NULL,
  "symbol" text NOT NULL,
  "venue_payment_id" text NOT NULL,
  "amount_quote" numeric(38, 18) NOT NULL,
  "funding_time" bigint NOT NULL,
  "mode" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "funding_payments_venue_symbol_payment_uidx"
  ON "funding_payments" ("venue", "symbol", "venue_payment_id");

-- Revoke from the current session role (role-agnostic: works regardless of DB username).
DO $$
BEGIN
  EXECUTE format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON funding_payments FROM %I',
    current_user
  );
EXCEPTION WHEN others THEN
  -- Ignore if the role has no such privilege (e.g. superuser implicit grants).
  NULL;
END
$$;

CREATE TRIGGER funding_payments_immutable
  BEFORE UPDATE OR DELETE ON funding_payments
  FOR EACH ROW EXECUTE FUNCTION raise_audit_immutable();

CREATE TRIGGER funding_payments_no_truncate
  BEFORE TRUNCATE ON funding_payments
  FOR EACH STATEMENT EXECUTE FUNCTION raise_audit_immutable();
