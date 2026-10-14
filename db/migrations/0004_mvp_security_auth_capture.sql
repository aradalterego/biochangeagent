-- MVP: security hardening, passwordless sign-in + staff MFA, knowledge index status and delete,
-- agent policy, structured case feedback, treatment files.
-- Expand-only: no column or table is dropped, so the previous application version keeps working.

-- ---------------------------------------------------------------------------
-- Sessions: idle timeout and MFA state
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Users: external identity (magic link / Google via the identity provider) and TOTP MFA
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN auth_provider text;
ALTER TABLE users ADD COLUMN auth_subject text;
CREATE UNIQUE INDEX users_auth_identity_idx ON users(auth_provider, auth_subject) WHERE auth_subject IS NOT NULL;
ALTER TABLE users ADD COLUMN invited_at timestamptz;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
ALTER TABLE users ADD COLUMN totp_secret_enc text;          -- AES-256-GCM, key from AUTH_ENCRYPTION_KEY
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_last_step bigint;         -- replay protection: a code is accepted once

-- One-time sign-in links issued by the development identity provider only.
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  email       citext NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Generic fixed-window rate limiting (uploads, sign-in links, exports).
CREATE TABLE rate_limit_hits (
  id   bigserial PRIMARY KEY,
  key  text NOT NULL,
  at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_hits_key_idx ON rate_limit_hits(key, at DESC);

-- ---------------------------------------------------------------------------
-- Knowledge: explicit index status so ingestion problems are never silent
-- ---------------------------------------------------------------------------
ALTER TABLE knowledge_sources ADD COLUMN index_status text NOT NULL DEFAULT 'not_indexed'
  CHECK (index_status IN ('not_indexed', 'indexed', 'keyword_only', 'failed'));
ALTER TABLE knowledge_sources ADD COLUMN index_error text;
ALTER TABLE knowledge_sources ADD COLUMN indexed_at timestamptz;

UPDATE knowledge_sources s SET
  index_status = CASE
    WHEN EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.source_id = s.id AND c.embedding IS NOT NULL) THEN 'indexed'
    WHEN EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.source_id = s.id) THEN 'keyword_only'
    ELSE 'not_indexed' END,
  indexed_at = CASE WHEN EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.source_id = s.id) THEN now() END;

-- ---------------------------------------------------------------------------
-- Agent policy (managed by BioChange in Admin). Versioned: the newest row is active.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_policies (
  id                        bigserial PRIMARY KEY,
  allowed_topics            text,
  disallowed_topics         text,
  out_of_scope_message      text,
  escalation_contact_name   text,
  escalation_contact_email  text,
  escalation_contact_phone  text,
  product_scope             text[] NOT NULL DEFAULT '{}',
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Clinical data capture: structured product / usability feedback per case
-- ---------------------------------------------------------------------------
CREATE TABLE case_feedback (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  phase               text NOT NULL DEFAULT 'treatment' CHECK (phase IN ('treatment', 'follow_up', 'general')),
  product_id          uuid REFERENCES products(id) ON DELETE SET NULL,
  product_rating      smallint CHECK (product_rating BETWEEN 1 AND 5),
  ease_of_use_rating  smallint CHECK (ease_of_use_rating BETWEEN 1 AND 5),
  would_use_again     text CHECK (would_use_again IN ('yes', 'no', 'unsure')),
  product_feedback    text,
  usability_feedback  text,
  handling_notes      text,
  source              text NOT NULL DEFAULT 'ui' CHECK (source IN ('ui', 'chat')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_feedback_case_idx ON case_feedback(case_id, created_at);

-- Treatment files exported from practice-management systems; soft delete with storage removal.
ALTER TABLE case_files DROP CONSTRAINT case_files_file_type_check;
ALTER TABLE case_files ADD CONSTRAINT case_files_file_type_check
  CHECK (file_type IN ('radiograph', 'clinical_image', 'document', 'treatment_file', 'other'));
ALTER TABLE case_files ADD COLUMN sha256 text;
ALTER TABLE case_files ADD COLUMN deleted_at timestamptz;
ALTER TABLE case_files ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX case_files_case_idx ON case_files(case_id) WHERE deleted_at IS NULL;

-- Dashboard filters.
CREATE INDEX cases_status_idx ON cases(status, updated_at DESC);
CREATE INDEX cases_created_idx ON cases(created_at DESC);

-- ---------------------------------------------------------------------------
-- Same Supabase lockdown as 0002 for the new tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
  END IF;
END $$;
