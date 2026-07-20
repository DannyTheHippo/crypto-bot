-- W1 (Grafana rebuild): read-only Postgres role for Grafana's DB-truth panels (positions, agent
-- decisions/thesis, round trips, promotion progress). Idempotent — safe to re-run against a DB
-- that already has the role.
--
-- v3 (spec §9): the perp lane's separate `postgres-perp` DB/service is deleted — one process, one
-- Postgres, one book (docker-compose.yml's four-container shape). This file now applies to that
-- single `postgres` service only; the v2 dual-lane apply commands below are gone with it.
--
-- Password source: the OS/container environment variable GRAFANA_RO_PASSWORD, read via psql's
-- \getenv (psql 13+; postgres:16 image ships it). docker-compose.yml wires it for:
--   1. Fresh-volume bootstrap: mounted at /docker-entrypoint-initdb.d/grafana_ro.sql on `postgres` —
--      the postgres entrypoint runs every *.sql there via `psql -f` ONCE, inheriting the
--      container's own environment. Initdb scripts ONLY run on first container start against an
--      EMPTY data volume.
--   2. Manual apply against an ALREADY-RUNNING DB (initdb never re-runs on an existing volume) —
--      GRAFANA_RO_PASSWORD exported in the invoking shell first:
--        docker compose exec -T -e GRAFANA_RO_PASSWORD postgres \
--          psql -U cryptobot -d cryptobot -f /dev/stdin < observability/grafana/grafana_ro.sql
--      (`-e` forwards the shell's GRAFANA_RO_PASSWORD into the `exec`'d process; the postgres
--      service does not need it in `environment:` for this manual path, only for the initdb-mount
--      path above.)
--
-- Interpolation note: psql's `:'var'` client-side substitution is deliberately DISABLED inside
-- dollar-quoted (`$$...$$`) regions (so a DO block body's own literal `:name` text — PL/pgSQL
-- syntax, JSON operators, etc. — is never corrupted) — a naive `DO $$ ... PASSWORD :'var' ... $$`
-- would send the literal 9-character string `:'var'` as the password, not its value. The
-- format(...)+\gexec idiom below stays OUTSIDE any dollar-quoted body: `:'grafana_ro_password'`
-- substitutes client-side into the SELECT text, format(%L) then has the SERVER safely quote the
-- resulting literal into the generated CREATE/ALTER ROLE statement, and `\gexec` executes that
-- statement — each SELECT's WHERE guards which of the two ever actually runs.
--
-- SELECT ONLY, by design: grafana_ro must never see INSERT/UPDATE/DELETE — Grafana renders truth,
-- it never writes it. No schema beyond `public` exists in the DB (see drizzle/0000_initial.sql —
-- every trading table lives in the default schema), so USAGE + SELECT are scoped there.

\set ON_ERROR_STOP on
\getenv grafana_ro_password GRAFANA_RO_PASSWORD

SELECT format('CREATE ROLE grafana_ro LOGIN PASSWORD %L', :'grafana_ro_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'grafana_ro')
\gexec

SELECT format('ALTER ROLE grafana_ro LOGIN PASSWORD %L', :'grafana_ro_password')
WHERE EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'grafana_ro')
\gexec

GRANT CONNECT ON DATABASE cryptobot TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_ro;
-- Future tables (new migrations) are granted automatically without a re-run of this script — scoped
-- to objects created by the migration-applying role (cryptobot, the same role every drizzle-kit push
-- runs as in this deployment).
ALTER DEFAULT PRIVILEGES FOR ROLE cryptobot IN SCHEMA public GRANT SELECT ON TABLES TO grafana_ro;
