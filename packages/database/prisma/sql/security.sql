-- ---------------------------------------------------------------------------
-- Tenant isolation hardening.
--
-- Applied by `npm run db:secure` after `prisma migrate deploy`, because these are properties
-- Prisma's schema language cannot express. They are idempotent, so re-running is safe.
--
-- This is the *backstop*, not the primary control. Application-level scoping (see
-- TenantScopedRepository) is what should keep queries in their lane; row-level security is what
-- turns a bug in that layer from a data breach into an empty result set.
--
-- The application connects as a role that is NOT the table owner and does NOT have BYPASSRLS.
-- A superuser or table owner silently ignores RLS, which is the most common way a team ships
-- policies that never actually run.
-- ---------------------------------------------------------------------------

-- ── Application role ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tessera_app') THEN
    CREATE ROLE tessera_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tessera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tessera_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tessera_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tessera_app;

-- The audit log is append-only at the grant level. An attacker who reaches the application
-- role still cannot rewrite history.
REVOKE UPDATE, DELETE ON audit_logs FROM tessera_app;

-- ── Row-level security ──────────────────────────────────────────────────────
-- `app.current_org` is set per transaction by withTenantTransaction(). `SET LOCAL` is
-- transaction-scoped, so a pooled connection cannot carry one tenant's setting into the next
-- tenant's query — the failure mode that makes naive RLS-with-pooling unsafe.

DO $$
DECLARE
  target text;
  tenant_tables text[] := ARRAY[
    'organization_members', 'organization_groups', 'workspaces', 'workspace_members',
    'bases', 'base_members', 'tables', 'fields', 'field_dependencies',
    'records', 'record_links', 'record_revisions',
    'views', 'view_shares', 'comments', 'comment_mentions', 'comment_reactions',
    'notifications', 'forms', 'form_submissions',
    'interfaces', 'interface_pages', 'interface_components',
    'automations', 'automation_versions', 'automation_runs', 'automation_run_steps',
    'webhooks', 'webhook_deliveries', 'integration_connections',
    'attachments', 'invitations', 'usage_events', 'usage_summaries',
    'audit_logs', 'domain_events', 'deleted_items', 'invoices'
  ];
BEGIN
  FOREACH target IN ARRAY tenant_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = target) THEN

      -- A tenant table without `organization_id` cannot be protected by this policy. Fail loudly
      -- and name it: silently skipping would leave exactly one unguarded table, which is the
      -- worst possible outcome because nobody would know.
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public'
                       AND table_name = target
                       AND column_name = 'organization_id') THEN
        RAISE EXCEPTION
          'Table "%" is listed as tenant-owned but has no organization_id column. Add the column or remove it from the list.',
          target;
      END IF;

      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
      -- FORCE so the policy applies to the table owner too, which is what makes it testable
      -- in development where the app often connects as the owner.
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
      EXECUTE format($p$
        CREATE POLICY tenant_isolation ON %I
          USING (organization_id = current_setting('app.current_org', true))
          WITH CHECK (organization_id = current_setting('app.current_org', true))
      $p$, target);
    END IF;
  END LOOP;
END
$$;

-- ── Indexes that Prisma cannot express ──────────────────────────────────────

-- Case-insensitive uniqueness on email. Two accounts differing only in case is a
-- credential-confusion bug waiting to happen.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- The default grid access path: tenant, table, not-deleted, ordered by id.
CREATE INDEX IF NOT EXISTS idx_records_table_seq
  ON records (organization_id, table_id, id) WHERE deleted_at IS NULL;

-- Containment queries for filters on fields that have not been promoted to a typed slot.
CREATE INDEX IF NOT EXISTS idx_records_data_gin
  ON records USING gin (data jsonb_path_ops) WHERE deleted_at IS NULL;

-- Promoted slot indexes. Created here for the slots in the base schema; the field-promotion
-- job creates them CONCURRENTLY for slots it assigns later.
CREATE INDEX IF NOT EXISTS idx_records_s0 ON records (organization_id, table_id, s0) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_records_s1 ON records (organization_id, table_id, s1) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_records_n0 ON records (organization_id, table_id, n0) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_records_n1 ON records (organization_id, table_id, n1) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_records_d0 ON records (organization_id, table_id, d0) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_records_d1 ON records (organization_id, table_id, d1) WHERE deleted_at IS NULL;

-- Keeps single-cell updates on-page (HOT) rather than rewriting to a new page and touching
-- every index. Records are updated far more often than they are inserted.
ALTER TABLE records SET (fillfactor = 80);

-- ── Structural integrity ────────────────────────────────────────────────────

-- A workspace grant addresses exactly one subject. Without this, a row with both — or neither —
-- is representable, and the permission loader would have to guess.
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_member_subject;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_member_subject
  CHECK ((user_id IS NULL) <> (group_id IS NULL));

ALTER TABLE base_members DROP CONSTRAINT IF EXISTS base_member_subject;
ALTER TABLE base_members ADD CONSTRAINT base_member_subject
  CHECK ((user_id IS NULL) <> (group_id IS NULL));

-- ── Statement safety defaults for the application role ──────────────────────
-- A query with no bound cannot run for an hour and take the primary's CPU with it.
ALTER ROLE tessera_app SET statement_timeout = '30s';
ALTER ROLE tessera_app SET lock_timeout = '3s';
ALTER ROLE tessera_app SET idle_in_transaction_session_timeout = '60s';
