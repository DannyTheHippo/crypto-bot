-- Append-only hardening for audit_log and order_events.
-- Two layers are required:
--   1. REVOKE UPDATE, DELETE, TRUNCATE prevents non-owner sessions (application role) from
--      mutating rows. Role name is discovered at runtime to avoid hardcoding the DB username.
--   2. A BEFORE UPDATE OR DELETE OR TRUNCATE trigger covers the owner (table owner bypasses
--      GRANTs — only a trigger can stop owner-session mutations).

-- ── raise_audit_immutable ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION raise_audit_immutable()
  RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'table % is append-only; UPDATE, DELETE and TRUNCATE are prohibited', TG_TABLE_NAME;
END;
$$;

-- ── audit_log ────────────────────────────────────────────────────────────────

-- Revoke from the current session role (role-agnostic: works regardless of DB username).
DO $$
BEGIN
  EXECUTE format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM %I',
    current_user
  );
EXCEPTION WHEN others THEN
  -- Ignore if the role has no such privilege (e.g. superuser implicit grants).
  NULL;
END
$$;

-- Trigger covers owner sessions (owner bypasses GRANTs; trigger cannot be bypassed
-- without disabling it, which would itself be audited at the OS/superuser level).
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION raise_audit_immutable();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION raise_audit_immutable();

-- ── order_events ─────────────────────────────────────────────────────────────

-- Append-only journal per §7: same REVOKE + trigger treatment as audit_log.
DO $$
BEGIN
  EXECUTE format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON order_events FROM %I',
    current_user
  );
EXCEPTION WHEN others THEN
  NULL;
END
$$;

CREATE TRIGGER order_events_immutable
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION raise_audit_immutable();

CREATE TRIGGER order_events_no_truncate
  BEFORE TRUNCATE ON order_events
  FOR EACH STATEMENT EXECUTE FUNCTION raise_audit_immutable();
