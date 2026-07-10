-- experiments: append-only registry of every backtest/study trial ever run, for deflated-Sharpe
-- multiple-testing accounting (test/backtest/trial-registry.ts's harvest/variance consumes the
-- count). Same two-layer append-only hardening as audit_log/order_events/funding_events
-- (0001_append_only_hardening.sql / 0008_funding_events.sql): REVOKE UPDATE/DELETE/TRUNCATE from
-- the app role + a BEFORE trigger covering the owner. Reuses raise_audit_immutable() from 0001.

CREATE TABLE "experiments" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "family" text NOT NULL,
  "params_hash" text NOT NULL,
  "dataset_hash" text NOT NULL,
  "source" text NOT NULL,
  "label" text,
  "metrics" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Non-unique: the same (family, params_hash, dataset_hash) triple may legitimately be re-run
-- (e.g. a re-harvest at a different fee assumption still logs a new row) — this index only speeds
-- the COUNT DISTINCT triple-counting query, it does not dedupe.
CREATE INDEX "experiments_family_params_dataset_idx"
  ON "experiments" ("family", "params_hash", "dataset_hash");

DO $$
BEGIN
  EXECUTE format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON experiments FROM %I',
    current_user
  );
EXCEPTION WHEN others THEN
  NULL;
END
$$;

CREATE TRIGGER experiments_immutable
  BEFORE UPDATE OR DELETE ON experiments
  FOR EACH ROW EXECUTE FUNCTION raise_audit_immutable();

CREATE TRIGGER experiments_no_truncate
  BEFORE TRUNCATE ON experiments
  FOR EACH STATEMENT EXECUTE FUNCTION raise_audit_immutable();
