-- CreateTable
CREATE TABLE "users" (
    "id" CHAR(30) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "password_hash" TEXT,
    "name" VARCHAR(120) NOT NULL,
    "avatar_url" TEXT,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "theme" VARCHAR(10) NOT NULL DEFAULT 'system',
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret_cipher" BYTEA,
    "totp_secret_key_version" INTEGER,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" INET,
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "deletion_requested_at" TIMESTAMP(3),
    "notification_preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identities" (
    "id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_user_id" VARCHAR(255) NOT NULL,
    "email" VARCHAR(254),
    "refresh_token_cipher" BYTEA,
    "key_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_credentials" (
    "id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "label" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "family_id" CHAR(30) NOT NULL,
    "previous_token_hash" CHAR(64),
    "ip_address" INET,
    "user_agent" TEXT,
    "device_label" VARCHAR(120),
    "location" VARCHAR(120),
    "mfa_satisfied" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(64),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" CHAR(30) NOT NULL,
    "user_id" CHAR(30),
    "email" VARCHAR(254),
    "purpose" VARCHAR(32) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_ip" INET,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(48) NOT NULL,
    "logo_url" TEXT,
    "brand_color" CHAR(7),
    "plan" VARCHAR(20) NOT NULL DEFAULT 'free',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "region" VARCHAR(32) NOT NULL DEFAULT 'default',
    "shard_id" INTEGER NOT NULL DEFAULT 0,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "trial_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "invited_by_id" CHAR(30),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_groups" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" CHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_group_members" (
    "group_id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "workspace_grants" JSONB NOT NULL DEFAULT '[]',
    "token_hash" CHAR(64) NOT NULL,
    "message" TEXT,
    "invited_by_id" CHAR(30) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by_user_id" CHAR(30),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(64),
    "color" CHAR(7),
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "workspace_id" CHAR(30) NOT NULL,
    "user_id" CHAR(30),
    "group_id" CHAR(30),
    "role" VARCHAR(20) NOT NULL,
    "added_by_id" CHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bases" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "workspace_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(64),
    "color" CHAR(7),
    "position" INTEGER NOT NULL DEFAULT 0,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "template_id" CHAR(30),
    "archived_at" TIMESTAMP(3),
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "base_members" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30) NOT NULL,
    "user_id" CHAR(30),
    "group_id" CHAR(30),
    "role" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "base_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tables" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(64),
    "color" CHAR(7),
    "position" INTEGER NOT NULL DEFAULT 0,
    "primary_field_id" CHAR(30),
    "data_version" BIGINT NOT NULL DEFAULT 1,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "auto_number_seq" BIGINT NOT NULL DEFAULT 0,
    "hidden_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fields" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "table_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "is_unique" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '{}',
    "default_value" JSONB,
    "promoted_slot" VARCHAR(4),
    "promotionState" VARCHAR(16),
    "symmetric_field_id" CHAR(30),
    "compute_meta" JSONB,
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_dependencies" (
    "organization_id" CHAR(30) NOT NULL,
    "dependent_field_id" CHAR(30) NOT NULL,
    "source_field_id" CHAR(30) NOT NULL,
    "via_link_field_id" VARCHAR(30) NOT NULL DEFAULT '',

    CONSTRAINT "field_dependencies_pkey" PRIMARY KEY ("dependent_field_id","source_field_id","via_link_field_id")
);

-- CreateTable
CREATE TABLE "records" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "table_id" CHAR(30) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "s0" TEXT,
    "s1" TEXT,
    "s2" TEXT,
    "s3" TEXT,
    "n0" DECIMAL(38,10),
    "n1" DECIMAL(38,10),
    "n2" DECIMAL(38,10),
    "n3" DECIMAL(38,10),
    "d0" TIMESTAMP(3),
    "d1" TIMESTAMP(3),
    "d2" TIMESTAMP(3),
    "b0" BOOLEAN,
    "b1" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 1,
    "auto_number" BIGINT NOT NULL,
    "created_by_id" CHAR(30),
    "updated_by_id" CHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_links" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "field_id" CHAR(30) NOT NULL,
    "source_record_id" CHAR(30) NOT NULL,
    "target_record_id" CHAR(30) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_revisions" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "table_id" CHAR(30) NOT NULL,
    "record_id" CHAR(30) NOT NULL,
    "version" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" CHAR(30),
    "source" VARCHAR(24) NOT NULL,
    "correlation_id" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "views" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "table_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" VARCHAR(24) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(64),
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_personal" BOOLEAN NOT NULL DEFAULT false,
    "owner_id" CHAR(30),
    "locked_at" TIMESTAMP(3),
    "locked_by_id" CHAR(30),
    "config" JSONB NOT NULL DEFAULT '{}',
    "type_config" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "view_shares" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "view_id" CHAR(30) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "capability" VARCHAR(32) NOT NULL,
    "password_hash" TEXT,
    "domain_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allow_copy" BOOLEAN NOT NULL DEFAULT false,
    "allow_comments" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_accessed_at" TIMESTAMP(3),
    "access_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "view_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30) NOT NULL,
    "subject_type" VARCHAR(24) NOT NULL,
    "subject_id" CHAR(30) NOT NULL,
    "field_id" CHAR(30),
    "parent_id" CHAR(30),
    "body" JSONB NOT NULL,
    "plain_text" TEXT NOT NULL,
    "author_id" CHAR(30) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" CHAR(30),
    "edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_mentions" (
    "comment_id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("comment_id","user_id")
);

-- CreateTable
CREATE TABLE "comment_reactions" (
    "comment_id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("comment_id","user_id","emoji")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "user_id" CHAR(30) NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT,
    "target_url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "group_key" VARCHAR(120),
    "group_count" INTEGER NOT NULL DEFAULT 1,
    "read_at" TIMESTAMP(3),
    "emailed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30) NOT NULL,
    "table_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "requires_auth" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "captcha_enabled" BOOLEAN NOT NULL DEFAULT false,
    "submission_limit" INTEGER,
    "submission_count" INTEGER NOT NULL DEFAULT 0,
    "opens_at" TIMESTAMP(3),
    "closes_at" TIMESTAMP(3),
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "form_id" CHAR(30) NOT NULL,
    "record_id" CHAR(30),
    "submitted_by_id" CHAR(30),
    "ip_hash" CHAR(64),
    "user_agent" TEXT,
    "idempotency_key" VARCHAR(120),
    "status" VARCHAR(20) NOT NULL DEFAULT 'accepted',
    "error_detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interfaces" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(64),
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "interfaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interface_pages" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "interface_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "layout" JSONB NOT NULL DEFAULT '{}',
    "visibility_rule" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interface_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interface_components" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "page_id" CHAR(30) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "position" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "data_binding" JSONB,
    "visibility_rule" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interface_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "active_version_id" CHAR(30),
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_versions" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "automation_id" CHAR(30) NOT NULL,
    "version" INTEGER NOT NULL,
    "trigger" JSONB NOT NULL,
    "graph" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "published_at" TIMESTAMP(3),
    "published_by_id" CHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "automation_version_id" CHAR(30) NOT NULL,
    "trigger_event_id" CHAR(30) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "causation_chain" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "context" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(48),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_run_steps" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "run_id" CHAR(30) NOT NULL,
    "step_id" VARCHAR(64) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(16) NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" JSONB,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "automation_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30),
    "user_id" CHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "token_prefix" VARCHAR(16) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "base_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30) NOT NULL,
    "url" TEXT NOT NULL,
    "event_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret_cipher" BYTEA NOT NULL,
    "previous_secret_cipher" BYTEA,
    "secret_rotated_at" TIMESTAMP(3),
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failure_streak" INTEGER NOT NULL DEFAULT 0,
    "health" VARCHAR(16) NOT NULL DEFAULT 'healthy',
    "created_by_id" CHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "webhook_id" CHAR(30) NOT NULL,
    "event_id" CHAR(30) NOT NULL,
    "event_type" VARCHAR(48) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(16) NOT NULL,
    "response_code" INTEGER,
    "response_body" VARCHAR(2048),
    "latency_ms" INTEGER,
    "error_message" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "owner_scope" VARCHAR(16) NOT NULL,
    "owner_id" CHAR(30) NOT NULL,
    "external_account_id" VARCHAR(255),
    "external_account_label" VARCHAR(255),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "access_token_cipher" BYTEA NOT NULL,
    "refresh_token_cipher" BYTEA,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMP(3),
    "status" VARCHAR(16) NOT NULL DEFAULT 'connected',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "base_id" CHAR(30),
    "storage_key" TEXT NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(128) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" CHAR(64),
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "thumbnails" JSONB NOT NULL DEFAULT '{}',
    "scanStatus" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "scan_detail" TEXT,
    "uploaded_by_id" CHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "plan" VARCHAR(20) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "interval" VARCHAR(10) NOT NULL DEFAULT 'month',
    "seats" INTEGER NOT NULL DEFAULT 1,
    "external_customer_id" VARCHAR(64),
    "external_subscription_id" VARCHAR(64),
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "trial_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "subscription_id" CHAR(30) NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "number" VARCHAR(64),
    "status" VARCHAR(24) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "hosted_url" TEXT,
    "pdf_url" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "quantity" BIGINT NOT NULL,
    "subject_type" VARCHAR(24),
    "subject_id" CHAR(30),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_summaries" (
    "organization_id" CHAR(30) NOT NULL,
    "period_start" DATE NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "quantity" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_summaries_pkey" PRIMARY KEY ("organization_id","period_start","unit")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" CHAR(30),
    "impersonator_id" CHAR(30),
    "action" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "resource_id" CHAR(30),
    "before" JSONB,
    "after" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "correlation_id" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tenant" JSONB NOT NULL,
    "actor" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" VARCHAR(64),
    "causation_id" CHAR(30),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_items" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30) NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "resource_id" CHAR(30) NOT NULL,
    "parent_type" VARCHAR(32),
    "parent_id" CHAR(30),
    "name" VARCHAR(255),
    "deleted_by_id" CHAR(30),
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purge_after" TIMESTAMP(3) NOT NULL,
    "restored_at" TIMESTAMP(3),

    CONSTRAINT "deleted_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_percent" INTEGER NOT NULL DEFAULT 0,
    "enabled_org_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabled_org_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_by_id" CHAR(30),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" CHAR(30) NOT NULL,
    "organization_id" CHAR(30),
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "category" VARCHAR(48) NOT NULL,
    "description" TEXT,
    "cover_image_url" TEXT,
    "definition" JSONB NOT NULL,
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" CHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "identities_user_id_idx" ON "identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identities_provider_provider_user_id_key" ON "identities"("provider", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_credentials_credential_id_key" ON "user_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "user_credentials_user_id_idx" ON "user_credentials"("user_id");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "user_sessions_family_id_idx" ON "user_sessions"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "auth_tokens_expires_at_idx" ON "auth_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE INDEX "organizations_shard_id_idx" ON "organizations"("shard_id");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE INDEX "organization_members_organization_id_role_idx" ON "organization_members"("organization_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_groups_organization_id_name_key" ON "organization_groups"("organization_id", "name");

-- CreateIndex
CREATE INDEX "organization_group_members_user_id_idx" ON "organization_group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_email_idx" ON "invitations"("organization_id", "email");

-- CreateIndex
CREATE INDEX "invitations_expires_at_idx" ON "invitations"("expires_at");

-- CreateIndex
CREATE INDEX "workspaces_organization_id_archived_at_deleted_at_idx" ON "workspaces"("organization_id", "archived_at", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_organization_id_id_key" ON "workspaces"("organization_id", "id");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "workspace_members_organization_id_workspace_id_idx" ON "workspace_members"("organization_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_group_id_key" ON "workspace_members"("workspace_id", "group_id");

-- CreateIndex
CREATE INDEX "bases_organization_id_workspace_id_deleted_at_idx" ON "bases"("organization_id", "workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX "base_members_user_id_idx" ON "base_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "base_members_base_id_user_id_key" ON "base_members"("base_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "base_members_base_id_group_id_key" ON "base_members"("base_id", "group_id");

-- CreateIndex
CREATE INDEX "tables_organization_id_base_id_deleted_at_idx" ON "tables"("organization_id", "base_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "tables_base_id_name_key" ON "tables"("base_id", "name");

-- CreateIndex
CREATE INDEX "fields_organization_id_table_id_deleted_at_idx" ON "fields"("organization_id", "table_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "fields_table_id_name_key" ON "fields"("table_id", "name");

-- CreateIndex
CREATE INDEX "field_dependencies_organization_id_source_field_id_idx" ON "field_dependencies"("organization_id", "source_field_id");

-- CreateIndex
CREATE INDEX "records_organization_id_table_id_id_idx" ON "records"("organization_id", "table_id", "id");

-- CreateIndex
CREATE INDEX "records_organization_id_table_id_updated_at_idx" ON "records"("organization_id", "table_id", "updated_at");

-- CreateIndex
CREATE INDEX "record_links_organization_id_field_id_source_record_id_idx" ON "record_links"("organization_id", "field_id", "source_record_id");

-- CreateIndex
CREATE INDEX "record_links_organization_id_field_id_target_record_id_idx" ON "record_links"("organization_id", "field_id", "target_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_links_field_id_source_record_id_target_record_id_key" ON "record_links"("field_id", "source_record_id", "target_record_id");

-- CreateIndex
CREATE INDEX "record_revisions_organization_id_record_id_version_idx" ON "record_revisions"("organization_id", "record_id", "version");

-- CreateIndex
CREATE INDEX "record_revisions_organization_id_table_id_created_at_idx" ON "record_revisions"("organization_id", "table_id", "created_at");

-- CreateIndex
CREATE INDEX "views_organization_id_table_id_deleted_at_idx" ON "views"("organization_id", "table_id", "deleted_at");

-- CreateIndex
CREATE INDEX "views_owner_id_idx" ON "views"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "view_shares_slug_key" ON "view_shares"("slug");

-- CreateIndex
CREATE INDEX "view_shares_organization_id_view_id_idx" ON "view_shares"("organization_id", "view_id");

-- CreateIndex
CREATE INDEX "comments_organization_id_subject_type_subject_id_created_at_idx" ON "comments"("organization_id", "subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_parent_id_idx" ON "comments"("parent_id");

-- CreateIndex
CREATE INDEX "comment_mentions_user_id_idx" ON "comment_mentions"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_group_key_idx" ON "notifications"("organization_id", "user_id", "group_key");

-- CreateIndex
CREATE UNIQUE INDEX "forms_slug_key" ON "forms"("slug");

-- CreateIndex
CREATE INDEX "forms_organization_id_base_id_idx" ON "forms"("organization_id", "base_id");

-- CreateIndex
CREATE INDEX "form_submissions_organization_id_form_id_created_at_idx" ON "form_submissions"("organization_id", "form_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "form_submissions_form_id_idempotency_key_key" ON "form_submissions"("form_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "interfaces_organization_id_base_id_idx" ON "interfaces"("organization_id", "base_id");

-- CreateIndex
CREATE UNIQUE INDEX "interface_pages_interface_id_slug_key" ON "interface_pages"("interface_id", "slug");

-- CreateIndex
CREATE INDEX "interface_components_page_id_idx" ON "interface_components"("page_id");

-- CreateIndex
CREATE INDEX "automations_organization_id_base_id_idx" ON "automations"("organization_id", "base_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_versions_automation_id_version_key" ON "automation_versions"("automation_id", "version");

-- CreateIndex
CREATE INDEX "automation_runs_organization_id_status_created_at_idx" ON "automation_runs"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_automation_version_id_trigger_event_id_key" ON "automation_runs"("automation_version_id", "trigger_event_id");

-- CreateIndex
CREATE INDEX "automation_run_steps_run_id_step_id_idx" ON "automation_run_steps"("run_id", "step_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens"("user_id");

-- CreateIndex
CREATE INDEX "api_tokens_organization_id_idx" ON "api_tokens"("organization_id");

-- CreateIndex
CREATE INDEX "webhooks_organization_id_base_id_idx" ON "webhooks"("organization_id", "base_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_webhook_id_created_at_idx" ON "webhook_deliveries"("organization_id", "webhook_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries"("event_id");

-- CreateIndex
CREATE INDEX "integration_connections_organization_id_provider_idx" ON "integration_connections"("organization_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_organization_id_created_at_idx" ON "attachments"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_scanStatus_idx" ON "attachments"("scanStatus");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_external_subscription_id_key" ON "subscriptions"("external_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_external_id_key" ON "invoices"("external_id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_created_at_idx" ON "invoices"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_unit_occurred_at_idx" ON "usage_events"("organization_id", "unit", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_actor_id_created_at_idx" ON "audit_logs"("organization_id", "actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_resource_type_resource_id_idx" ON "audit_logs"("organization_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "domain_events_published_at_occurred_at_idx" ON "domain_events"("published_at", "occurred_at");

-- CreateIndex
CREATE INDEX "domain_events_organization_id_type_occurred_at_idx" ON "domain_events"("organization_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "deleted_items_organization_id_deleted_at_idx" ON "deleted_items"("organization_id", "deleted_at");

-- CreateIndex
CREATE INDEX "deleted_items_purge_after_idx" ON "deleted_items"("purge_after");

-- CreateIndex
CREATE UNIQUE INDEX "deleted_items_resource_type_resource_id_key" ON "deleted_items"("resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "templates_slug_key" ON "templates"("slug");

-- CreateIndex
CREATE INDEX "templates_category_visibility_idx" ON "templates"("category", "visibility");

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_groups" ADD CONSTRAINT "organization_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_group_members" ADD CONSTRAINT "organization_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "organization_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_group_members" ADD CONSTRAINT "organization_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "organization_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bases" ADD CONSTRAINT "bases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "base_members" ADD CONSTRAINT "base_members_base_id_fkey" FOREIGN KEY ("base_id") REFERENCES "bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_base_id_fkey" FOREIGN KEY ("base_id") REFERENCES "bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_dependencies" ADD CONSTRAINT "field_dependencies_dependent_field_id_fkey" FOREIGN KEY ("dependent_field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_dependencies" ADD CONSTRAINT "field_dependencies_source_field_id_fkey" FOREIGN KEY ("source_field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "views" ADD CONSTRAINT "views_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_shares" ADD CONSTRAINT "view_shares_view_id_fkey" FOREIGN KEY ("view_id") REFERENCES "views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interface_pages" ADD CONSTRAINT "interface_pages_interface_id_fkey" FOREIGN KEY ("interface_id") REFERENCES "interfaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interface_components" ADD CONSTRAINT "interface_components_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "interface_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_version_id_fkey" FOREIGN KEY ("automation_version_id") REFERENCES "automation_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_items" ADD CONSTRAINT "deleted_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
