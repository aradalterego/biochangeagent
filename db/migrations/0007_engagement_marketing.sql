-- Engagement: veterinarian registration fields, trigger events, admin-built reminder rules,
-- email templates and composed emails, feedback-for-discount offers, marketing materials. Expand-only.

-- ---------------------------------------------------------------------------
-- Veterinarian registration: customer / not a customer (title and country already exist)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN is_customer boolean NOT NULL DEFAULT false;
UPDATE users u SET is_customer = true
WHERE u.clinic_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM orders o WHERE o.clinic_id = u.clinic_id AND o.status NOT IN ('draft', 'cancelled'));

-- ---------------------------------------------------------------------------
-- Trigger events: what a veterinarian did, which reminder rules react to
-- ---------------------------------------------------------------------------
CREATE TABLE vet_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type   text NOT NULL CHECK (event_type IN ('registered', 'purchase', 'product_used', 'usage_question')),
  product_id   uuid REFERENCES products(id) ON DELETE SET NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'admin', 'order', 'case', 'chat')),
  source_ref   text,                         -- makes system-recorded events idempotent
  notes        text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vet_events_source_ref_idx ON vet_events(event_type, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX vet_events_type_idx ON vet_events(event_type, occurred_at);
CREATE INDEX vet_events_user_idx ON vet_events(user_id, occurred_at DESC);

-- Existing veterinarians count as registered when they were created (rules only apply from their start date).
INSERT INTO vet_events (user_id, event_type, occurred_at, source, source_ref)
SELECT id, 'registered', created_at, 'system', 'user:' || id FROM users WHERE role IN ('veterinarian', 'clinic_admin');

-- ---------------------------------------------------------------------------
-- Email templates (reusable subject + body with {{merge_tags}})
-- ---------------------------------------------------------------------------
CREATE TABLE email_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reminder rules: type, trigger event, delay / repeat interval, audience, content, optional offer
-- ---------------------------------------------------------------------------
CREATE TABLE reminder_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  reminder_type        text NOT NULL CHECK (reminder_type IN ('check_in', 'feedback_offer', 'reorder', 'usage_support', 'education', 'custom')),
  trigger_event        text NOT NULL CHECK (trigger_event IN ('registered', 'purchase', 'product_used', 'usage_question')),
  product_id           uuid REFERENCES products(id) ON DELETE SET NULL,   -- NULL = any product
  delay_days           integer NOT NULL CHECK (delay_days BETWEEN 0 AND 1095),
  repeat_every_days    integer CHECK (repeat_every_days BETWEEN 1 AND 1095),
  max_sends            integer NOT NULL DEFAULT 1 CHECK (max_sends BETWEEN 1 AND 24),
  audience             text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'customers', 'non_customers')),
  template_id          uuid REFERENCES email_templates(id) ON DELETE SET NULL,
  subject              text NOT NULL,
  body                 text NOT NULL,
  offer_discount       boolean NOT NULL DEFAULT false,
  discount_percent     integer CHECK (discount_percent BETWEEN 1 AND 100),
  offer_valid_days     integer NOT NULL DEFAULT 30 CHECK (offer_valid_days BETWEEN 1 AND 365),
  applies_from         date NOT NULL DEFAULT current_date,              -- events before this date are ignored
  active               boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT offer_discount OR discount_percent IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Outbound emails: rule reminders and emails written in Admin. dedupe_key prevents double sends.
-- ---------------------------------------------------------------------------
CREATE TABLE outbound_emails (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('rule', 'direct')),
  dedupe_key   text NOT NULL UNIQUE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  to_email     citext NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  rule_id      uuid REFERENCES reminder_rules(id) ON DELETE SET NULL,
  event_id     uuid REFERENCES vet_events(id) ON DELETE SET NULL,
  template_id  uuid REFERENCES email_templates(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  locked_at    timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX outbound_emails_status_idx ON outbound_emails(status, created_at);
CREATE INDEX outbound_emails_created_idx ON outbound_emails(created_at DESC);

-- ---------------------------------------------------------------------------
-- Feedback offers: short feedback from a veterinarian who uses the product now → discount on the next order
-- ---------------------------------------------------------------------------
CREATE TABLE feedback_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id           uuid REFERENCES reminder_rules(id) ON DELETE SET NULL,
  event_id          uuid REFERENCES vet_events(id) ON DELETE SET NULL,
  product_id        uuid REFERENCES products(id) ON DELETE SET NULL,
  discount_percent  integer NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'not_eligible')),
  expires_at        timestamptz NOT NULL,
  using_product     boolean,
  rating            smallint CHECK (rating BETWEEN 1 AND 5),
  comment           text,
  discount_code     text UNIQUE,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_offers_user_idx ON feedback_offers(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Marketing materials (uploaded in Admin, downloaded by veterinarians next to the chat)
-- ---------------------------------------------------------------------------
CREATE TABLE marketing_materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  description   text,
  category      text,
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,
  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    integer NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_downloads (
  id           bigserial PRIMARY KEY,
  material_id  uuid NOT NULL REFERENCES marketing_materials(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketing_downloads_material_idx ON marketing_downloads(material_id, at DESC);

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
