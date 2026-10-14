-- Follow-up reminders: default follow-up after treatment, reminder lifecycle, an email outbox
-- that prevents duplicates, and admin-editable settings. Expand-only.

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES
  ('follow_up.default_days', '90'),            -- default follow-up: treatment date + N days (3 months)
  ('follow_up.overdue_reminder_days', '14'),   -- second reminder N days after the due date (0 = off)
  ('follow_up.reminders_enabled', 'true');

ALTER TABLE follow_ups ADD COLUMN kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'default'));
ALTER TABLE follow_ups ADD COLUMN reminder_status text NOT NULL DEFAULT 'pending'
  CHECK (reminder_status IN ('pending', 'sent', 'failed', 'skipped', 'not_required'));
ALTER TABLE follow_ups ADD COLUMN reminder_sent_at timestamptz;
UPDATE follow_ups SET reminder_status = 'not_required' WHERE status <> 'scheduled';

-- At most one open default follow-up per case.
CREATE UNIQUE INDEX follow_ups_one_default_idx ON follow_ups(case_id) WHERE kind = 'default' AND status = 'scheduled';

-- Every reminder email goes through the outbox; dedupe_key makes each reminder unique.
CREATE TABLE notification_outbox (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('follow_up_due', 'follow_up_overdue')),
  dedupe_key    text NOT NULL UNIQUE,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  follow_up_id  uuid REFERENCES follow_ups(id) ON DELETE CASCADE,
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  locked_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX notification_outbox_status_idx ON notification_outbox(status, id);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON app_settings, notification_outbox FROM anon';
    EXECUTE 'REVOKE ALL ON SEQUENCE notification_outbox_id_seq FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON app_settings, notification_outbox FROM authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE notification_outbox_id_seq FROM authenticated';
  END IF;
END $$;
