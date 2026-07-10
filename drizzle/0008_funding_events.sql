-- funding_events: append-only journal of perp funding-payment settlements (B1).
-- Same two-layer append-only hardening as audit_log/order_events (0001_append_only_hardening.sql):
--   1. REVOKE UPDATE, DELETE, TRUNCATE prevents the application role from mutating rows.
--   2. A BEFORE UPDATE OR DELETE OR TRUNCATE trigger covers the owner (bypasses GRANTs).
-- Reuses raise_audit_immutable() defined in 0001 — one function, shared across every
-- append-only table, no re-declaration here.

CREATE TABLE "funding_events" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "strategy_id" text NOT NULL,
  "venue" text NOT NULL,
  "symbol" text NOT NULL,
  "funding_rate" numeric(38, 18) NOT NULL,
  "mark_price" numeric(38, 18) NOT NULL,
  "signed_qty" numeric(38, 18) NOT NULL,
  "payment_quote" numeric(38, 18) NOT NULL,
  "funding_time" timestamptz NOT NULL,
  "mode" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

-- Revoke from the current session role (role-agnostic: works regardless of DB username).
DO $$
BEGIN
  EXECUTE format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON funding_events FROM %I',
    current_user
  );
EXCEPTION WHEN others THEN
  -- Ignore if the role has no such privilege (e.g. superuser implicit grants).
  NULL;
END
$$;

CREATE TRIGGER funding_events_immutable
  BEFORE UPDATE OR DELETE ON funding_events
  FOR EACH ROW EXECUTE FUNCTION raise_audit_immutable();

CREATE TRIGGER funding_events_no_truncate
  BEFORE TRUNCATE ON funding_events
  FOR EACH STATEMENT EXECUTE FUNCTION raise_audit_immutable();
