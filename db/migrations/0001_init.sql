-- BioChange Vet Companion — core schema (V1)
--
-- Two categories of information live here and are intentionally kept apart:
--   * KNOWLEDGE  — knowledge_sources / knowledge_chunks / approved_claims / evidence_studies
--   * MEMORY + OPERATIONAL DATA — users, clinics, cases, inventory, orders, memories, ...
--
-- Enumerations are text + CHECK constraints so they can evolve with simple migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Organisations & identity
-- ---------------------------------------------------------------------------

CREATE TABLE distributors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  country         text,
  ordering_email  text,
  ordering_url    text,
  ordering_notes  text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinics (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                             text NOT NULL,
  address                          text,
  country                          text,
  timezone                         text NOT NULL DEFAULT 'UTC',
  distributor_id                   uuid REFERENCES distributors(id) ON DELETE SET NULL,
  estimated_dental_cases_per_month integer CHECK (estimated_dental_cases_per_month >= 0),
  created_at                       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  name                text NOT NULL,
  role                text NOT NULL CHECK (role IN ('veterinarian', 'clinic_admin', 'biochange_admin', 'biochange_medical')),
  clinic_id           uuid REFERENCES clinics(id) ON DELETE SET NULL,
  professional_title  text,
  country             text,
  timezone            text NOT NULL DEFAULT 'UTC',
  preferred_language  text NOT NULL DEFAULT 'en',
  password_hash       text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz
);
CREATE INDEX users_clinic_idx ON users(clinic_id);

-- Opaque session tokens; only a SHA-256 hash of the token is stored.
CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE login_attempts (
  id            bigserial PRIMARY KEY,
  email         citext NOT NULL,
  ip            text,
  success       boolean NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts(email, attempted_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts(ip, attempted_at DESC);

CREATE TABLE veterinarian_profiles (
  user_id                           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  veterinary_license                text,
  specialty                         text,
  years_in_practice                 integer CHECK (years_in_practice >= 0),
  dental_experience_level           text CHECK (dental_experience_level IN ('none', 'basic', 'intermediate', 'advanced', 'specialist')),
  regenerative_dentistry_experience text CHECK (regenerative_dentistry_experience IN ('none', 'some', 'experienced')),
  regum_training_status             text NOT NULL DEFAULT 'not_started' CHECK (regum_training_status IN ('not_started', 'in_progress', 'completed')),
  microfoam_training_status         text NOT NULL DEFAULT 'not_started' CHECK (microfoam_training_status IN ('not_started', 'in_progress', 'completed')),
  preferred_answer_depth            text NOT NULL DEFAULT 'balanced' CHECK (preferred_answer_depth IN ('concise', 'balanced', 'detailed')),
  notes                             text,
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- KNOWLEDGE (authoritative, versioned, human-approved)
-- ---------------------------------------------------------------------------

CREATE TABLE knowledge_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 text NOT NULL,
  source_type           text NOT NULL CHECK (source_type IN (
                          'ifu', 'regulatory', 'product_page', 'training_material', 'peer_reviewed_research',
                          'clinical_protocol', 'case_study', 'faq', 'distributor_material',
                          'commercial_information', 'internal_approved_document')),
  product               text,                 -- product family, e.g. 'ReGum Vet', 'MicroFoam', NULL = general
  authority_level       smallint NOT NULL CHECK (authority_level BETWEEN 1 AND 7),
  source_url            text,
  storage_path          text,                 -- uploaded file in private storage
  file_name             text,
  mime_type             text,
  content_hash          text,
  publication_date      date,
  version               text,
  country_or_market     text NOT NULL DEFAULT 'global',
  regulatory_status     text,
  status                text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'revoked', 'superseded')),
  approved_for_agent    boolean GENERATED ALWAYS AS (status = 'approved') STORED,
  clinical_or_commercial text NOT NULL DEFAULT 'clinical' CHECK (clinical_or_commercial IN ('clinical', 'commercial', 'both')),
  tags                  text[] NOT NULL DEFAULT '{}',
  extracted_text        text,
  parse_status          text NOT NULL DEFAULT 'not_parsed' CHECK (parse_status IN ('not_parsed', 'parsed', 'failed', 'placeholder')),
  parse_error           text,
  is_placeholder        boolean NOT NULL DEFAULT false,   -- seeded reference with no real content yet
  supersedes_source_id  uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  last_reviewed_at      timestamptz,
  reviewed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  effective_from        date,
  effective_until       date,
  notes                 text,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_sources_status_idx ON knowledge_sources(status, product);

-- Structured metadata for peer-reviewed evidence (one row per study source).
CREATE TABLE evidence_studies (
  source_id            uuid PRIMARY KEY REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  publication          text,
  authors              text,
  journal              text,
  year                 integer,
  study_design         text,
  sample_size          text,
  intervention         text,
  control              text,
  outcomes             text,
  limitations          text,
  funding_conflicts    text,
  key_approved_claims  text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE knowledge_chunks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  chunk_index       integer NOT NULL,
  content           text NOT NULL,
  -- metadata preserved with every chunk (copied from the source at index time)
  source_title      text NOT NULL,
  source_type       text NOT NULL,
  authority_level   smallint NOT NULL,
  product           text,
  document_version  text,
  country           text,
  section           text,
  page              integer,
  claim_type        text,
  approved_status   text NOT NULL,
  embedding         vector(1536),
  tsv               tsvector GENERATED ALWAYS AS (
                      setweight(to_tsvector('english', coalesce(section, '')), 'A') ||
                      setweight(to_tsvector('english', content), 'B')) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, chunk_index)
);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin(tsv);
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX knowledge_chunks_source_idx ON knowledge_chunks(source_id);

CREATE TABLE approved_claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim               text NOT NULL,
  product             text NOT NULL,
  claim_type          text NOT NULL CHECK (claim_type IN ('mechanism', 'indication', 'handling', 'biocompatibility', 'biodegradation', 'clinical_evidence', 'commercial', 'safety', 'other')),
  market              text NOT NULL DEFAULT 'global',
  source_id           uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  allowed_context     text,
  restricted_wording  text,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Products & commercial operations
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                            text NOT NULL,
  product_family                  text NOT NULL,       -- 'ReGum Vet' | 'MicroFoam'
  variant                         text,                -- configuration / shape / size
  sku                             text NOT NULL UNIQUE,
  form                            text,
  units_per_package               integer NOT NULL DEFAULT 1 CHECK (units_per_package > 0),
  active                          boolean NOT NULL DEFAULT true,
  market                          text NOT NULL DEFAULT 'global',
  description                     text,
  current_information_source_id   uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  is_placeholder_sku              boolean NOT NULL DEFAULT false,
  created_at                      timestamptz NOT NULL DEFAULT now()
);

-- Inventory: confirmed count (stated by a human) vs estimated count (derived from usage).
CREATE TABLE inventory (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_confirmed  integer CHECK (quantity_confirmed >= 0),
  last_confirmed_at   timestamptz,
  last_confirmed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  quantity_estimated  integer,                       -- may drift negative if usage exceeds known stock
  lot                 text,
  expiry              date,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, product_id)
);

CREATE TABLE inventory_events (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  product_id                 uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  event_type                 text NOT NULL CHECK (event_type IN ('confirmed_count', 'usage', 'order_received', 'adjustment')),
  quantity                   integer NOT NULL,       -- units; usage is positive units consumed
  estimated_after            integer,
  case_id                    uuid,
  order_id                   uuid,
  note                       text,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_events_clinic_idx ON inventory_events(clinic_id, product_id, created_at DESC);

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id),
  quantity         integer NOT NULL CHECK (quantity > 0),   -- packages
  order_date       date,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'confirmed', 'shipped', 'received', 'cancelled')),
  distributor_id   uuid REFERENCES distributors(id) ON DELETE SET NULL,
  distributor      text,
  price            numeric(12, 2),
  currency         text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_clinic_idx ON orders(clinic_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Cases & follow-ups
-- ---------------------------------------------------------------------------

CREATE TABLE cases (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  created_by                  uuid REFERENCES users(id) ON DELETE SET NULL,
  internal_patient_identifier text,
  species                     text NOT NULL DEFAULT 'dog',
  breed                       text,
  age                         text,
  tooth                       text,
  condition_summary           text,
  pocket_depth_mm             numeric(4, 1),
  defect_type                 text,
  furcation                   text,
  procedure_type              text,
  treatment_goal              text,
  product_id                  uuid REFERENCES products(id) ON DELETE SET NULL,
  product_variant             text,
  treatment_date              date,
  status                      text NOT NULL DEFAULT 'discussion' CHECK (status IN ('discussion', 'planned', 'treated', 'follow_up_due', 'followed_up', 'closed')),
  baseline_notes              text,
  follow_up_date              date,
  outcome_notes               text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_clinic_idx ON cases(clinic_id, updated_at DESC);

ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_case_fk FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL;
ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

CREATE TABLE case_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE follow_ups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  due_at        date NOT NULL,
  reason        text,
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  completed_at  timestamptz,
  notes         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX follow_ups_case_idx ON follow_ups(case_id);
CREATE INDEX follow_ups_due_idx ON follow_ups(status, due_at);

-- Baseline vs follow-up measurements are kept as separate rows so neither overwrites the other.
CREATE TABLE case_measurements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('baseline', 'follow_up')),
  follow_up_id        uuid REFERENCES follow_ups(id) ON DELETE SET NULL,
  measured_at         date NOT NULL DEFAULT current_date,
  tooth               text,
  pocket_depth_mm     numeric(4, 1),
  attachment_level_mm numeric(4, 1),
  mobility            text,
  furcation           text,
  notes               text,
  recorded_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_measurements_case_idx ON case_measurements(case_id, measured_at);

CREATE TABLE case_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  file_type     text NOT NULL CHECK (file_type IN ('radiograph', 'clinical_image', 'document', 'other')),
  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    integer NOT NULL,
  description   text,
  follow_up_id  uuid REFERENCES follow_ups(id) ON DELETE SET NULL,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Education, adoption & memory
-- ---------------------------------------------------------------------------

CREATE TABLE education_resources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  resource_type  text NOT NULL CHECK (resource_type IN ('product_education', 'tutorial', 'webinar', 'study', 'case_study', 'training_course', 'faq')),
  product        text,
  url            text,
  source_id      uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  description    text,
  level          text CHECK (level IN ('intro', 'intermediate', 'advanced')),
  counts_as_training boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE education_activity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id    uuid REFERENCES education_resources(id) ON DELETE SET NULL,
  resource_type  text,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  completed      boolean NOT NULL DEFAULT false,
  completed_at   timestamptz
);
CREATE INDEX education_activity_user_idx ON education_activity(user_id, opened_at DESC);

CREATE TABLE adoption_states (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  clinic_id           uuid REFERENCES clinics(id) ON DELETE SET NULL,
  state               text NOT NULL CHECK (state IN ('lead', 'interested', 'trained', 'ordered', 'first_use_pending', 'first_use_completed', 'active', 'repeat_user', 'dormant')),
  last_transition_at  timestamptz NOT NULL DEFAULT now(),
  reason              text
);

CREATE TABLE adoption_transitions (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_state  text,
  to_state    text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id         uuid REFERENCES clinics(id) ON DELETE CASCADE,
  memory_type       text NOT NULL CHECK (memory_type IN ('preference', 'training', 'product_usage', 'ordering', 'experience', 'workflow', 'other')),
  content           text NOT NULL,
  structured_value  jsonb,
  confidence        real NOT NULL DEFAULT 0.8 CHECK (confidence BETWEEN 0 AND 1),
  source            text NOT NULL,          -- e.g. 'conversation:<message id>', 'admin', 'seed'
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_user_idx ON memories(user_id, active, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Conversations (the application DB is the canonical archive)
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id                uuid REFERENCES clinics(id) ON DELETE SET NULL,
  channel                  text NOT NULL DEFAULT 'web',
  title                    text,
  active_case_id           uuid REFERENCES cases(id) ON DELETE SET NULL,
  openai_conversation_id   text,
  started_at               timestamptz NOT NULL DEFAULT now(),
  last_message_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations(user_id, last_message_at DESC);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content          text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

CREATE TABLE case_conversations (
  case_id          uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, conversation_id)
);

-- Post-response structured extraction (suggestions, not silent mutations).
CREATE TABLE extracted_facts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fact_type          text NOT NULL CHECK (fact_type IN ('user_fact', 'case_fact', 'product_usage', 'inventory_statement', 'order_intent', 'follow_up_request', 'training_completion', 'unanswered_question')),
  value              jsonb NOT NULL,
  confidence         real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Medical support, knowledge gaps, audit
-- ---------------------------------------------------------------------------

CREATE TABLE medical_support_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id         uuid REFERENCES clinics(id) ON DELETE SET NULL,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  case_id           uuid REFERENCES cases(id) ON DELETE SET NULL,
  question          text NOT NULL,
  product           text,
  sources_checked   jsonb NOT NULL DEFAULT '[]',
  agent_summary     text,
  urgency           text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'urgent')),
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'answered', 'closed')),
  answer            text,
  answered_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_at       timestamptz,
  answer_seen_at    timestamptz,
  converted_source_id uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX msr_status_idx ON medical_support_requests(status, created_at DESC);
CREATE INDEX msr_user_idx ON medical_support_requests(user_id, created_at DESC);

CREATE TABLE knowledge_gaps (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_question  text NOT NULL UNIQUE,
  question             text NOT NULL,
  product              text,
  frequency            integer NOT NULL DEFAULT 1,
  sources_searched     jsonb NOT NULL DEFAULT '[]',
  reason_unresolved    text,
  escalated            boolean NOT NULL DEFAULT false,
  escalation_id        uuid REFERENCES medical_support_requests(id) ON DELETE SET NULL,
  resolved_source_id   uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_gap_occurrences (
  id               bigserial PRIMARY KEY,
  gap_id           uuid NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_gap_occurrences_gap_idx ON knowledge_gap_occurrences(gap_id);

CREATE TABLE audit_log (
  id                 bigserial PRIMARY KEY,
  timestamp          timestamptz NOT NULL DEFAULT now(),
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  action             text NOT NULL,
  entity_type        text NOT NULL,
  entity_id          text,
  tool               text,               -- agent tool name, or 'ui' / 'admin' / 'system'
  input_summary      text,
  result             text NOT NULL CHECK (result IN ('success', 'denied', 'error')),
  source_message_id  uuid REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_log_user_idx ON audit_log(user_id, timestamp DESC);
