import "server-only";
import { sql, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email";
import { log } from "@/lib/log";
import { assertBioChangeAdmin, ValidationError, type Actor } from "@/lib/authz";

/**
 * Follow-up system:
 *   - every treated case gets a DEFAULT follow-up at treatment date + N days (setting, 90 by default),
 *     unless a follow-up was already scheduled or completed; it moves when the treatment date changes
 *   - a daily job emails the treating veterinarian when a follow-up is due, and once more when it is
 *     overdue; every email goes through notification_outbox, whose unique dedupe_key guarantees that
 *     the same reminder is never sent twice, even if the job runs concurrently or repeatedly
 *   - failures are retried (up to MAX_ATTEMPTS, at most hourly) and are visible in Admin
 */

export interface FollowUpSettings {
  defaultDays: number;
  overdueReminderDays: number;
  remindersEnabled: boolean;
}

const DEFAULTS: FollowUpSettings = { defaultDays: 90, overdueReminderDays: 14, remindersEnabled: true };
const MAX_ATTEMPTS = 5;

export async function getFollowUpSettings(db: Tx = sql): Promise<FollowUpSettings> {
  const rows = await db<{ key: string; value: unknown }[]>`SELECT key, value FROM app_settings WHERE key LIKE 'follow_up.%'`;
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    defaultDays: Number(v["follow_up.default_days"] ?? DEFAULTS.defaultDays),
    overdueReminderDays: Number(v["follow_up.overdue_reminder_days"] ?? DEFAULTS.overdueReminderDays),
    remindersEnabled: (v["follow_up.reminders_enabled"] ?? DEFAULTS.remindersEnabled) === true,
  };
}

export async function saveFollowUpSettings(actor: Actor, input: FollowUpSettings): Promise<void> {
  assertBioChangeAdmin(actor);
  if (!Number.isInteger(input.defaultDays) || input.defaultDays < 1 || input.defaultDays > 730) {
    throw new ValidationError("Default follow-up must be 1–730 days after treatment.");
  }
  if (!Number.isInteger(input.overdueReminderDays) || input.overdueReminderDays < 0 || input.overdueReminderDays > 365) {
    throw new ValidationError("Overdue reminder must be 0–365 days (0 = off).");
  }
  const before = await getFollowUpSettings();
  await sql.begin(async (tx) => {
    for (const [key, value] of [
      ["follow_up.default_days", input.defaultDays],
      ["follow_up.overdue_reminder_days", input.overdueReminderDays],
      ["follow_up.reminders_enabled", input.remindersEnabled],
    ] as const) {
      await tx`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (${key}, ${tx.json(value)}, ${actor.userId}, now())
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    }
    await audit(actor, {
      action: "settings.follow_up", entityType: "app_settings", entityId: "follow_up", tool: "admin",
      inputSummary: `default ${before.defaultDays}→${input.defaultDays} d; overdue ${before.overdueReminderDays}→${input.overdueReminderDays} d; reminders ${input.remindersEnabled ? "on" : "off"}`,
    }, tx);
  });
}

/**
 * Creates or moves the case's default follow-up (call inside the transaction that changed the case).
 * A changed period applies to follow-ups created or moved from then on; existing dates are kept.
 */
export async function ensureDefaultFollowUp(tx: Tx, caseId: string, userId: string | null): Promise<void> {
  const [c] = await tx<{ treatment_date: Date | null; status: string }[]>`SELECT treatment_date, status FROM cases WHERE id = ${caseId}`;
  if (!c?.treatment_date || c.status === "closed") return;
  const { defaultDays } = await getFollowUpSettings(tx);
  const due = new Date(c.treatment_date.getTime() + defaultDays * 864e5).toISOString().slice(0, 10);
  const [existingDefault] = await tx<{ id: string; due_at: Date }[]>`
    SELECT id, due_at FROM follow_ups WHERE case_id = ${caseId} AND kind = 'default' AND status = 'scheduled'`;
  if (existingDefault) {
    if (existingDefault.due_at.toISOString().slice(0, 10) !== due) {
      await tx`UPDATE follow_ups SET due_at = ${due}, reminder_status = 'pending', reminder_sent_at = NULL WHERE id = ${existingDefault.id}`;
    }
  } else {
    // Only when the veterinarian has not already planned (or done) a follow-up themselves.
    await tx`
      INSERT INTO follow_ups (case_id, due_at, reason, created_by, kind)
      SELECT ${caseId}, ${due}, ${`Follow-up ${defaultDays} days after treatment`}, ${userId}, 'default'
      WHERE NOT EXISTS (SELECT 1 FROM follow_ups WHERE case_id = ${caseId} AND status IN ('scheduled', 'completed'))
      ON CONFLICT (case_id) WHERE kind = 'default' AND status = 'scheduled' DO NOTHING`;
  }
  await tx`UPDATE cases SET follow_up_date = (SELECT min(due_at) FROM follow_ups WHERE case_id = ${caseId} AND status = 'scheduled') WHERE id = ${caseId}`;
}

// ---------------------------------------------------------------------------
// Reminder job
// ---------------------------------------------------------------------------

export interface ReminderRunResult {
  enqueued: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** Today in the clinic's timezone (unknown timezone names fall back to UTC instead of failing the job). */
const clinicToday = () => sql`(now() AT TIME ZONE coalesce((SELECT name FROM pg_timezone_names WHERE name = cl.timezone LIMIT 1), 'UTC'))::date`;

export async function runFollowUpReminders(opts: { limit?: number } = {}): Promise<ReminderRunResult> {
  const settings = await getFollowUpSettings();
  const result: ReminderRunResult = { enqueued: 0, sent: 0, failed: 0, skipped: 0 };
  if (!settings.remindersEnabled) return result;

  // 1. Enqueue. The due date is part of the key, so a moved follow-up gets a fresh reminder.
  const due = await sql`
    INSERT INTO notification_outbox (kind, dedupe_key, user_id, follow_up_id, case_id)
    SELECT 'follow_up_due', 'follow_up:' || f.id || ':due:' || f.due_at, c.created_by, f.id, c.id
    FROM follow_ups f JOIN cases c ON c.id = f.case_id JOIN clinics cl ON cl.id = c.clinic_id
    WHERE f.status = 'scheduled' AND c.status <> 'closed' AND f.reminder_status = 'pending' AND f.due_at <= ${clinicToday()}
    ON CONFLICT (dedupe_key) DO NOTHING`;
  result.enqueued += due.count;
  if (settings.overdueReminderDays > 0) {
    const overdue = await sql`
      INSERT INTO notification_outbox (kind, dedupe_key, user_id, follow_up_id, case_id)
      SELECT 'follow_up_overdue', 'follow_up:' || f.id || ':overdue:' || f.due_at, c.created_by, f.id, c.id
      FROM follow_ups f JOIN cases c ON c.id = f.case_id JOIN clinics cl ON cl.id = c.clinic_id
      WHERE f.status = 'scheduled' AND c.status <> 'closed' AND f.reminder_status = 'sent'
        AND f.due_at + ${settings.overdueReminderDays}::int <= ${clinicToday()}
      ON CONFLICT (dedupe_key) DO NOTHING`;
    result.enqueued += overdue.count;
  }

  // 2. Deliver, one claimed row at a time (safe if two runs overlap: SKIP LOCKED + status).
  const limit = opts.limit ?? 200;
  for (let i = 0; i < limit; i++) {
    const [job] = await sql<{ id: string; kind: "follow_up_due" | "follow_up_overdue"; user_id: string | null; follow_up_id: string; case_id: string; attempts: number }[]>`
      UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, locked_at = now()
      WHERE id = (
        SELECT id FROM notification_outbox
        WHERE status = 'pending'
           OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS} AND locked_at < now() - interval '1 hour')
           OR (status = 'sending' AND locked_at < now() - interval '15 minutes')
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, user_id, follow_up_id, case_id, attempts`;
    if (!job) break;
    const outcome = await deliver(job);
    result[outcome]++;
  }
  if (result.enqueued || result.sent || result.failed) log.info("follow_up.reminders_run", { ...result });
  return result;
}

async function deliver(
  job: { id: string; kind: "follow_up_due" | "follow_up_overdue"; user_id: string | null; follow_up_id: string; case_id: string; attempts: number },
): Promise<"sent" | "failed" | "skipped"> {
  const [d] = await sql<{
    f_status: string; due_at: Date; c_status: string; tooth: string | null; patient: string | null; product: string | null; treatment_date: Date | null;
    email: string | null; name: string | null; active: boolean | null;
  }[]>`
    SELECT f.status AS f_status, f.due_at, c.status AS c_status, c.tooth, c.internal_patient_identifier AS patient, p.name AS product, c.treatment_date,
           u.email, u.name, u.active
    FROM follow_ups f JOIN cases c ON c.id = f.case_id LEFT JOIN products p ON p.id = c.product_id LEFT JOIN users u ON u.id = ${job.user_id}
    WHERE f.id = ${job.follow_up_id}`;

  const skip = async (reason: string, followUpStatus: "skipped" | "not_required") => {
    await sql`UPDATE notification_outbox SET status = 'skipped', last_error = ${reason} WHERE id = ${job.id}`;
    if (job.kind === "follow_up_due") await sql`UPDATE follow_ups SET reminder_status = ${followUpStatus} WHERE id = ${job.follow_up_id}`;
    return "skipped" as const;
  };
  if (!d || d.f_status !== "scheduled" || d.c_status === "closed") return skip("follow-up no longer open", "not_required");
  if (!d.email || !d.active) return skip("no active recipient", "skipped");

  const label = [d.product ?? "Case", d.tooth && `tooth ${d.tooth}`, d.patient].filter(Boolean).join(" · ");
  const dueStr = d.due_at.toISOString().slice(0, 10);
  const link = `${env().APP_URL.replace(/\/$/, "")}/cases/${job.case_id}`;
  const overdue = job.kind === "follow_up_overdue";
  try {
    // Minimal content: no clinical findings in email, only what identifies the case for the vet.
    await sendEmail({
      to: d.email,
      subject: overdue ? `Follow-up overdue: ${label}` : `Follow-up due: ${label}`,
      text: [
        `Hello ${d.name ?? ""},`.trim(),
        "",
        overdue
          ? `The follow-up for your case ${label}${d.treatment_date ? ` (treated ${d.treatment_date.toISOString().slice(0, 10)})` : ""} was due on ${dueStr} and has not been recorded yet.`
          : `The follow-up for your case ${label}${d.treatment_date ? ` (treated ${d.treatment_date.toISOString().slice(0, 10)})` : ""} is due on ${dueStr}.`,
        "",
        `Record the follow-up result here: ${link}`,
        "If you already saw the patient, recording the result also stops further reminders.",
        "",
        "BioChange Vet Companion",
      ].join("\n"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : "send failed";
    await sql`UPDATE notification_outbox SET status = 'failed', last_error = ${message}, locked_at = now() WHERE id = ${job.id}`;
    if (job.kind === "follow_up_due") await sql`UPDATE follow_ups SET reminder_status = 'failed' WHERE id = ${job.follow_up_id} AND status = 'scheduled'`;
    log.error("follow_up.reminder_failed", { outbox: job.id, attempt: job.attempts, err });
    return "failed";
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE notification_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = ${job.id}`;
    await tx`UPDATE follow_ups SET reminder_status = 'sent', reminder_sent_at = now() WHERE id = ${job.follow_up_id}`;
    await audit(null, { action: `follow_up.reminder_${overdue ? "overdue" : "due"}`, entityType: "follow_up", entityId: job.follow_up_id, tool: "system" }, tx);
  });
  return "sent";
}

export async function reminderOverview() {
  const [counts] = await sql<{ scheduled: number; due_30d: number; overdue: number; sent_7d: number; failed: number }[]>`
    SELECT
      (SELECT count(*)::int FROM follow_ups WHERE status = 'scheduled') AS scheduled,
      (SELECT count(*)::int FROM follow_ups WHERE status = 'scheduled' AND due_at BETWEEN current_date AND current_date + 30) AS due_30d,
      (SELECT count(*)::int FROM follow_ups WHERE status = 'scheduled' AND due_at < current_date) AS overdue,
      (SELECT count(*)::int FROM notification_outbox WHERE status = 'sent' AND sent_at > now() - interval '7 days') AS sent_7d,
      (SELECT count(*)::int FROM notification_outbox WHERE status = 'failed') AS failed`;
  const recent = await sql<{ id: string; kind: string; status: string; attempts: number; last_error: string | null; created_at: Date; sent_at: Date | null; case_id: string; recipient: string | null }[]>`
    SELECT o.id, o.kind, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, o.case_id, u.name AS recipient
    FROM notification_outbox o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 30`;
  return { counts, recent };
}
