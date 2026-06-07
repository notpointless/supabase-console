-- [console fork] Standard Supabase migration bookkeeping table. Present on every
-- project so the dashboard's Migrations view + the GitHub deploy pipeline have a
-- place to record applied migrations (matches supabase_migrations.schema_migrations).
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text NOT NULL PRIMARY KEY,
    statements text[],
    name text,
    created_by text,
    idempotency_key text UNIQUE
);

GRANT USAGE ON SCHEMA supabase_migrations TO postgres, service_role;
GRANT ALL ON supabase_migrations.schema_migrations TO postgres, service_role;
