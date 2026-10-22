import "server-only";
import crypto from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email";
import { log } from "@/lib/log";
import { assertBioChangeAdmin, NotFoundError, ValidationError, type Actor } from "@/lib/authz";
import { isUuid } from "./cases";

/**
 * Engagement emails built in Admin:
 *   - vet_events record what a veterinarian did (registered, purchased, used a product in a case,
 *     asked the agent how to use a product)
 *   - reminder_rules react to an event after N days (optionally repeating), for an audience, with a
 *     subject/body that supports {{merge_tags}}; a rule can attach a feedback-for-discount offer
 *   - emails written in Admin go out through the same outbox, so every email is retried, never sent
 *     twice (unique dedupe_key) and visible in Admin
 */

export const TRIGGER_EVENTS = ["purchase", "product_used", "usage_question", "registered"] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];
export const TRIGGER_LABELS: Record<TriggerEvent, string> = {
  purchase: "Veterinarian bought a product",
  product_used: "Veterinarian used a product in a case",
  usage_question: "Veterinarian asked the AI agent about using a product",
  registered: "Veterinarian registered",
};

export const REMINDER_TYPES = ["check_in", "feedback_offer", "reorder", "usage_support", "education", "custom"] as const;
export type ReminderType = (typeof REMINDER_TYPES)[number];
export const REMINDER_TYPE_LABELS: Record<ReminderType, string> = {
  check_in: "Check-in (is everything OK?)",
  feedback_offer: "Feedback for a discount",
  reorder: "Reorder reminder",
  usage_support: "Usage support",
  education: "Education / training",
  custom: "Custom",
};

export const AUDIENCES = ["all", "customers", "non_customers"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_LABELS: Record<Audience, string> = { all: "All veterinarians", customers: "Customers only", non_customers: "Non-customers only" };

export const MERGE_TAGS = ["first_name", "name", "title", "country", "product", "feedback_link", "discount_percent", "offer_expires", "app_url"] as const;

const MAX_ATTEMPTS = 5;
const appUrl = () => env().APP_URL.replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface VetEventInput {
  userId: string;
  type: TriggerEvent;
  productId?: string | null;
  occurredAt?: string | Date | null;
  source: "system" | "admin" | "order" | "case" | "chat";
  sourceRef?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

/** Idempotent when sourceRef is given. A purchase also marks the veterinarian as a customer. */
export async function recordVetEvent(db: Tx, e: VetEventInput): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO vet_events (user_id, event_type, product_id, occurred_at, source, source_ref, notes, created_by)
    VALUES (${e.userId}, ${e.type}, ${e.productId ?? null}, ${e.occurredAt ?? new Date()}, ${e.source}, ${e.sourceRef ?? null}, ${e.notes ?? null}, ${e.createdBy ?? null})
    ON CONFLICT (event_type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
    RETURNING id`;
  if (row && e.type === "purchase") await db`UPDATE users SET is_customer = true WHERE id = ${e.userId}`;
  return row?.id ?? null;
}

/** An order placed by a clinic counts as a purchase for every veterinarian of that clinic who placed or confirmed it. */
export async function recordOrderPurchase(db: Tx, orderId: string): Promise<void> {
  const [o] = await db<{ product_id: string; created_by: string | null; confirmed_by: string | null }[]>`
    SELECT product_id, created_by, confirmed_by FROM orders WHERE id = ${orderId}`;
  if (!o) return;
  for (const userId of new Set([o.confirmed_by, o.created_by].filter((v): v is string => Boolean(v)))) {
    await recordVetEvent(db, { userId, type: "purchase", productId: o.product_id, source: "order", sourceRef: `order:${orderId}:${userId}` });
  }
}

/** First treatment of a case with a product counts as "used a product". */
export async function recordCaseProductUse(db: Tx, caseId: string): Promise<void> {
  const [c] = await db<{ created_by: string | null; product_id: string | null; treatment_date: Date | null }[]>`
    SELECT created_by, product_id, treatment_date FROM cases WHERE id = ${caseId}`;
  if (!c?.created_by || !c.product_id || !c.treatment_date) return;
  await recordVetEvent(db, { userId: c.created_by, type: "product_used", productId: c.product_id, occurredAt: c.treatment_date, source: "case", sourceRef: `case:${caseId}` });
}

/** The agent was asked how to use a product (one event per conversation). The product is matched from the text when it is named. */
export async function recordUsageQuestion(userId: string, conversationId: string, text: string): Promise<void> {
  const products = await sql<{ id: string; product_family: string }[]>`SELECT DISTINCT ON (product_family) id, product_family FROM products WHERE active ORDER BY product_family, created_at`;
  const lower = text.toLowerCase();
  const product = products.find((p) => lower.includes(p.product_family.toLowerCase()));
  await recordVetEvent(sql, { userId, type: "usage_question", productId: product?.id ?? null, source: "chat", sourceRef: `conversation:${conversationId}` });
}

export async function logEventFromAdmin(actor: Actor, input: { userId: string | null; type: string | null; productId: string | null; occurredAt: string | null; notes: string | null }): Promise<void> {
  assertBioChangeAdmin(actor);
  if (!isUuid(input.userId)) throw new ValidationError("Choose a veterinarian.");
  if (!TRIGGER_EVENTS.includes(input.type as TriggerEvent)) throw new ValidationError("Choose an event.");
  if (input.productId && !isUuid(input.productId)) throw new ValidationError("Unknown product.");
  if (input.occurredAt && Number.isNaN(Date.parse(input.occurredAt))) throw new ValidationError("Invalid date.");
  const [u] = await sql`SELECT 1 FROM users WHERE id = ${input.userId} AND role IN ('veterinarian', 'clinic_admin')`;
  if (!u) throw new ValidationError("Choose a veterinarian.");
  await sql.begin(async (tx) => {
    const id = await recordVetEvent(tx, {
      userId: input.userId!, type: input.type as TriggerEvent, productId: input.productId, occurredAt: input.occurredAt || null,
      source: "admin", notes: input.notes, createdBy: actor.userId,
    });
    await audit(actor, { action: "vet_event.create", entityType: "vet_event", entityId: id, tool: "admin", inputSummary: input.type }, tx);
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function saveTemplate(actor: Actor, input: { id?: string | null; name: string | null; subject: string | null; body: string | null }): Promise<string> {
  assertBioChangeAdmin(actor);
  if (!input.name || !input.subject || !input.body) throw new ValidationError("Name, subject and body are required.");
  if (input.subject.length > 200) throw new ValidationError("The subject is too long (max 200 characters).");
  if (input.body.length > 20_000) throw new ValidationError("The body is too long.");
  const [row] = input.id
    ? await sql<{ id: string }[]>`UPDATE email_templates SET name = ${input.name}, subject = ${input.subject}, body = ${input.body}, updated_at = now() WHERE id = ${input.id} RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO email_templates (name, subject, body, created_by) VALUES (${input.name}, ${input.subject}, ${input.body}, ${actor.userId}) RETURNING id`;
  if (!row) throw new NotFoundError("Template not found.");
  await audit(actor, { action: input.id ? "email_template.update" : "email_template.create", entityType: "email_template", entityId: row.id, tool: "admin", inputSummary: input.name });
  return row.id;
}

export async function deleteTemplate(actor: Actor, id: string): Promise<void> {
  assertBioChangeAdmin(actor);
  await sql`DELETE FROM email_templates WHERE id = ${id}`;
  await audit(actor, { action: "email_template.delete", entityType: "email_template", entityId: id, tool: "admin" });
}

export async function listTemplates() {
  return sql<{ id: string; name: string; subject: string; body: string; updated_at: Date }[]>`
    SELECT id, name, subject, body, updated_at FROM email_templates ORDER BY name`;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleInput {
  id?: string | null;
  name: string | null;
  reminderType: string | null;
  triggerEvent: string | null;
  productId: string | null;
  delayDays: number | null;
  repeatEveryDays: number | null;
  maxSends: number | null;
  audience: string | null;
  templateId: string | null;
  subject: string | null;
  body: string | null;
  offerDiscount: boolean;
  discountPercent: number | null;
  offerValidDays: number | null;
  appliesFrom: string | null;
  active: boolean;
}

export async function saveRule(actor: Actor, input: RuleInput): Promise<string> {
  assertBioChangeAdmin(actor);
  if (!input.name) throw new ValidationError("Give the rule a name.");
  if (!REMINDER_TYPES.includes(input.reminderType as ReminderType)) throw new ValidationError("Choose a reminder type.");
  if (!TRIGGER_EVENTS.includes(input.triggerEvent as TriggerEvent)) throw new ValidationError("Choose a trigger event.");
  if (!AUDIENCES.includes((input.audience ?? "all") as Audience)) throw new ValidationError("Choose an audience.");
  const delay = input.delayDays;
  if (delay == null || !Number.isInteger(delay) || delay < 0 || delay > 1095) throw new ValidationError("Send after must be 0–1095 days.");
  const maxSends = input.maxSends ?? 1;
  if (!Number.isInteger(maxSends) || maxSends < 1 || maxSends > 24) throw new ValidationError("Number of sends must be 1–24.");
  const repeat = maxSends > 1 ? input.repeatEveryDays : null;
  if (maxSends > 1 && (repeat == null || !Number.isInteger(repeat) || repeat < 1 || repeat > 1095)) throw new ValidationError("Repeat every must be 1–1095 days when sending more than once.");
  if (input.productId && !isUuid(input.productId)) throw new ValidationError("Unknown product.");
  if (input.templateId && !isUuid(input.templateId)) throw new ValidationError("Unknown template.");
  let { subject, body } = input;
  if (input.templateId && (!subject || !body)) {
    const [t] = await sql<{ subject: string; body: string }[]>`SELECT subject, body FROM email_templates WHERE id = ${input.templateId}`;
    if (!t) throw new ValidationError("Template not found.");
    subject ||= t.subject;
    body ||= t.body;
  }
  if (!subject || !body) throw new ValidationError("Enter a subject and body, or choose a template.");
  const offer = input.offerDiscount || input.reminderType === "feedback_offer";
  const pct = offer ? input.discountPercent : null;
  if (offer && (pct == null || !Number.isInteger(pct) || pct < 1 || pct > 100)) throw new ValidationError("Enter the discount (1–100%).");
  const valid = input.offerValidDays ?? 30;
  if (!Number.isInteger(valid) || valid < 1 || valid > 365) throw new ValidationError("The offer must be valid for 1–365 days.");
  if (input.appliesFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.appliesFrom)) throw new ValidationError("Invalid start date.");
  const values = {
    name: input.name, reminder_type: input.reminderType, trigger_event: input.triggerEvent, product_id: input.productId || null,
    delay_days: delay, repeat_every_days: repeat, max_sends: maxSends, audience: input.audience ?? "all", template_id: input.templateId || null,
    subject, body, offer_discount: offer, discount_percent: pct, offer_valid_days: valid, active: input.active,
    ...(input.appliesFrom ? { applies_from: input.appliesFrom } : {}),
  };
  const [row] = input.id
    ? await sql<{ id: string }[]>`UPDATE reminder_rules SET ${sql(values)}, updated_at = now() WHERE id = ${input.id} RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO reminder_rules ${sql({ ...values, created_by: actor.userId })} RETURNING id`;
  if (!row) throw new NotFoundError("Rule not found.");
  await audit(actor, { action: input.id ? "reminder_rule.update" : "reminder_rule.create", entityType: "reminder_rule", entityId: row.id, tool: "admin",
    inputSummary: `${input.name}: ${input.triggerEvent} +${delay}d${repeat ? ` every ${repeat}d ×${maxSends}` : ""}${offer ? ` offer ${pct}%` : ""}` });
  return row.id;
}

export async function setRuleActive(actor: Actor, id: string, active: boolean): Promise<void> {
  assertBioChangeAdmin(actor);
  await sql`UPDATE reminder_rules SET active = ${active}, updated_at = now() WHERE id = ${id}`;
  await audit(actor, { action: active ? "reminder_rule.activate" : "reminder_rule.pause", entityType: "reminder_rule", entityId: id, tool: "admin" });
}

export async function deleteRule(actor: Actor, id: string): Promise<void> {
  assertBioChangeAdmin(actor);
  await sql`DELETE FROM reminder_rules WHERE id = ${id}`;
  await audit(actor, { action: "reminder_rule.delete", entityType: "reminder_rule", entityId: id, tool: "admin" });
}

export interface RuleRow {
  id: string; name: string; reminder_type: ReminderType; trigger_event: TriggerEvent; product_id: string | null; product: string | null;
  delay_days: number; repeat_every_days: number | null; max_sends: number; audience: Audience; template_id: string | null;
  subject: string; body: string; offer_discount: boolean; discount_percent: number | null; offer_valid_days: number;
  applies_from: Date; active: boolean; sent: number; pending: number; created_at: Date;
}

export async function listRules(): Promise<RuleRow[]> {
  return sql<RuleRow[]>`
    SELECT r.*, p.name AS product,
      (SELECT count(*)::int FROM outbound_emails o WHERE o.rule_id = r.id AND o.status = 'sent') AS sent,
      (SELECT count(*)::int FROM outbound_emails o WHERE o.rule_id = r.id AND o.status IN ('pending', 'failed', 'sending')) AS pending
    FROM reminder_rules r LEFT JOIN products p ON p.id = r.product_id ORDER BY r.active DESC, r.created_at DESC`;
}

export async function getRule(id: string): Promise<RuleRow | null> {
  if (!isUuid(id)) return null;
  const [r] = await sql<RuleRow[]>`SELECT r.*, p.name AS product, 0 AS sent, 0 AS pending FROM reminder_rules r LEFT JOIN products p ON p.id = r.product_id WHERE r.id = ${id}`;
  return r ?? null;
}

/** Human-readable schedule, e.g. "30 days after purchase, then every 30 days (3 emails)". */
export function describeSchedule(r: Pick<RuleRow, "delay_days" | "repeat_every_days" | "max_sends" | "trigger_event">): string {
  const first = r.delay_days === 0 ? "Right after the event" : `${r.delay_days} day${r.delay_days === 1 ? "" : "s"} after the event`;
  return r.max_sends > 1 && r.repeat_every_days ? `${first}, then every ${r.repeat_every_days} days (${r.max_sends} emails)` : first;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderTemplate(text: string, vars: Partial<Record<(typeof MERGE_TAGS)[number], string | null | undefined>>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) => (key in vars ? (vars as Record<string, string | null | undefined>)[key] ?? "" : m));
}

function recipientVars(u: { name: string; professional_title: string | null; country: string | null }) {
  return { first_name: u.name.split(/\s+/)[0], name: u.name, title: u.professional_title ?? "", country: u.country ?? "", app_url: appUrl() };
}

// ---------------------------------------------------------------------------
// Emails written in Admin
// ---------------------------------------------------------------------------

export interface ComposeInput {
  userIds: string[];
  audience: "selected" | Audience;
  country: string | null;
  productId: string | null;
  subject: string | null;
  body: string | null;
  templateId: string | null;
}

/** Recipients of a composed email: chosen veterinarians, or a segment (customers, country, product). */
export async function resolveRecipients(input: Pick<ComposeInput, "userIds" | "audience" | "country" | "productId">) {
  const ids = input.userIds.filter(isUuid);
  const productId = isUuid(input.productId) ? input.productId : null;
  return sql<{ id: string; email: string; name: string; professional_title: string | null; country: string | null }[]>`
    SELECT u.id, u.email, u.name, u.professional_title, coalesce(u.country, c.country) AS country
    FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id
    WHERE u.active AND u.role IN ('veterinarian', 'clinic_admin')
      AND ${input.audience === "selected" ? sql`u.id = ANY(${ids}::uuid[])` : sql`true`}
      AND ${input.audience === "customers" ? sql`u.is_customer` : input.audience === "non_customers" ? sql`NOT u.is_customer` : sql`true`}
      AND (${input.audience === "selected" ? null : input.country}::text IS NULL OR coalesce(u.country, c.country) = ${input.audience === "selected" ? null : input.country})
      AND (${input.audience === "selected" ? null : productId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM vet_events e WHERE e.user_id = u.id AND e.product_id = ${productId} AND e.event_type IN ('purchase', 'product_used')))
    ORDER BY u.name`;
}

export async function composeEmail(actor: Actor, input: ComposeInput): Promise<{ queued: number; sent: number; failed: number }> {
  assertBioChangeAdmin(actor);
  if (!input.subject || !input.body) throw new ValidationError("Enter a subject and a message.");
  if (input.subject.length > 200) throw new ValidationError("The subject is too long (max 200 characters).");
  if (input.body.length > 20_000) throw new ValidationError("The message is too long.");
  if (input.audience === "selected" && !input.userIds.length) throw new ValidationError("Choose at least one recipient.");
  const recipients = await resolveRecipients(input);
  if (!recipients.length) throw new ValidationError("No active veterinarians match these recipients.");
  if (recipients.length > 2000) throw new ValidationError("Too many recipients for one email (max 2000).");
  const batch = crypto.randomUUID();
  await sql.begin(async (tx) => {
    for (const r of recipients) {
      const vars = recipientVars(r);
      await tx`
        INSERT INTO outbound_emails (kind, dedupe_key, user_id, to_email, subject, body, template_id, created_by)
        VALUES ('direct', ${`direct:${batch}:${r.id}`}, ${r.id}, ${r.email}, ${renderTemplate(input.subject!, vars)}, ${renderTemplate(input.body!, vars)},
                ${isUuid(input.templateId) ? input.templateId : null}, ${actor.userId})`;
    }
    await audit(actor, { action: "email.compose", entityType: "outbound_email", entityId: batch, tool: "admin", inputSummary: `${recipients.length} recipient(s): ${input.subject}` }, tx);
  });
  const delivered = await deliverOutboundEmails({ limit: Math.min(recipients.length, 50) });
  return { queued: recipients.length, sent: delivered.sent, failed: delivered.failed };
}

// ---------------------------------------------------------------------------
// Rule job + delivery
// ---------------------------------------------------------------------------

export interface EngagementRunResult {
  enqueued: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** Queues every rule email whose time has come, then delivers the outbox. Safe to run repeatedly. */
export async function runEngagementJobs(opts: { limit?: number; now?: Date } = {}): Promise<EngagementRunResult> {
  const result: EngagementRunResult = { enqueued: 0, sent: 0, failed: 0, skipped: 0 };
  const now = opts.now ?? new Date();
  const rules = await sql<RuleRow[]>`SELECT r.*, NULL AS product, 0 AS sent, 0 AS pending FROM reminder_rules r WHERE r.active`;
  for (const rule of rules) {
    const due = await sql<{
      event_id: string; user_id: string; product_id: string | null; n: number; email: string; name: string;
      professional_title: string | null; country: string | null; product: string | null;
    }[]>`
      SELECT e.id AS event_id, e.user_id, coalesce(e.product_id, ${rule.product_id}::uuid) AS product_id, s.n,
             u.email, u.name, u.professional_title, coalesce(u.country, c.country) AS country, p.product_family AS product
      FROM vet_events e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN clinics c ON c.id = u.clinic_id
      LEFT JOIN products p ON p.id = coalesce(e.product_id, ${rule.product_id}::uuid)
      CROSS JOIN generate_series(0, ${rule.max_sends - 1}::int) AS s(n)
      WHERE e.event_type = ${rule.trigger_event}
        AND (${rule.product_id}::uuid IS NULL OR e.product_id = ${rule.product_id}::uuid)
        AND e.occurred_at >= ${rule.applies_from}::date
        AND u.active
        AND ${rule.audience === "customers" ? sql`u.is_customer` : rule.audience === "non_customers" ? sql`NOT u.is_customer` : sql`true`}
        AND (s.n = 0 OR ${rule.repeat_every_days}::int IS NOT NULL)
        AND e.occurred_at + make_interval(days => ${rule.delay_days}::int + s.n * coalesce(${rule.repeat_every_days}::int, 0)) <= ${now}
        -- a missed repeat is not sent late: only the first email, or repeats due within the last 14 days
        AND (s.n = 0 OR e.occurred_at + make_interval(days => ${rule.delay_days}::int + s.n * coalesce(${rule.repeat_every_days}::int, 0)) > ${now}::timestamptz - interval '14 days')
        AND NOT EXISTS (SELECT 1 FROM outbound_emails o WHERE o.dedupe_key = 'rule:' || ${rule.id} || ':' || e.id || ':' || s.n)
      ORDER BY e.occurred_at
      LIMIT 500`;
    for (const d of due) {
      const offerId = rule.offer_discount ? crypto.randomUUID() : null;
      const expires = new Date(now.getTime() + rule.offer_valid_days * 864e5);
      const vars = {
        ...recipientVars(d),
        product: d.product ?? "BioChange products",
        feedback_link: offerId ? `${appUrl()}/offers/${offerId}` : "",
        discount_percent: rule.discount_percent != null ? String(rule.discount_percent) : "",
        offer_expires: offerId ? expires.toISOString().slice(0, 10) : "",
      };
      let body = renderTemplate(rule.body, vars);
      if (offerId && !rule.body.includes("feedback_link")) {
        body += `\n\nShare short feedback and get ${rule.discount_percent}% off your next order: ${vars.feedback_link}`;
      }
      await sql.begin(async (tx) => {
        const [inserted] = await tx<{ id: string }[]>`
          INSERT INTO outbound_emails (kind, dedupe_key, user_id, to_email, subject, body, rule_id, event_id, template_id)
          VALUES ('rule', ${`rule:${rule.id}:${d.event_id}:${d.n}`}, ${d.user_id}, ${d.email}, ${renderTemplate(rule.subject, vars)}, ${body},
                  ${rule.id}, ${d.event_id}, ${rule.template_id})
          ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
        if (!inserted) return;
        result.enqueued++;
        if (offerId) {
          await tx`INSERT INTO feedback_offers (id, user_id, rule_id, event_id, product_id, discount_percent, expires_at)
                   VALUES (${offerId}, ${d.user_id}, ${rule.id}, ${d.event_id}, ${d.product_id}, ${rule.discount_percent}, ${expires})`;
        }
      });
    }
  }
  const delivered = await deliverOutboundEmails({ limit: opts.limit ?? 300 });
  result.sent = delivered.sent;
  result.failed = delivered.failed;
  result.skipped = delivered.skipped;
  if (result.enqueued || result.sent || result.failed) log.info("engagement.run", { ...result });
  return result;
}

export async function deliverOutboundEmails(opts: { limit?: number } = {}): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  const e = env();
  for (let i = 0; i < (opts.limit ?? 300); i++) {
    const [job] = await sql<{ id: string; to_email: string; subject: string; body: string; user_id: string | null; attempts: number; active: boolean | null }[]>`
      WITH claimed AS (
        UPDATE outbound_emails SET status = 'sending', attempts = attempts + 1, locked_at = now()
        WHERE id = (
          SELECT id FROM outbound_emails
          WHERE status = 'pending'
             OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS} AND locked_at < now() - interval '1 hour')
             OR (status = 'sending' AND locked_at < now() - interval '15 minutes')
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, to_email, subject, body, user_id, attempts)
      SELECT claimed.*, u.active FROM claimed LEFT JOIN users u ON u.id = claimed.user_id`;
    if (!job) break;
    if (job.user_id && job.active === false) {
      await sql`UPDATE outbound_emails SET status = 'skipped', last_error = 'recipient deactivated' WHERE id = ${job.id}`;
      out.skipped++;
      continue;
    }
    try {
      await sendEmail({ to: job.to_email, subject: job.subject, text: job.body, from: e.MARKETING_EMAIL_FROM || undefined, replyTo: e.EMAIL_REPLY_TO || undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : "send failed";
      await sql`UPDATE outbound_emails SET status = 'failed', last_error = ${message}, locked_at = now() WHERE id = ${job.id}`;
      log.error("engagement.email_failed", { email: job.id, attempt: job.attempts, err });
      out.failed++;
      continue;
    }
    await sql`UPDATE outbound_emails SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = ${job.id}`;
    out.sent++;
  }
  return out;
}

export async function listOutboundEmails(opts: { kind?: "rule" | "direct"; limit?: number } = {}) {
  return sql<{ id: string; kind: string; to_email: string; recipient: string | null; subject: string; status: string; attempts: number; last_error: string | null; rule: string | null; created_at: Date; sent_at: Date | null }[]>`
    SELECT o.id, o.kind, o.to_email, u.name AS recipient, o.subject, o.status, o.attempts, o.last_error, r.name AS rule, o.created_at, o.sent_at
    FROM outbound_emails o LEFT JOIN users u ON u.id = o.user_id LEFT JOIN reminder_rules r ON r.id = o.rule_id
    WHERE (${opts.kind ?? null}::text IS NULL OR o.kind = ${opts.kind ?? null})
    ORDER BY o.created_at DESC LIMIT ${opts.limit ?? 50}`;
}

export async function listVetEvents(limit = 100) {
  return sql<{ id: string; event_type: TriggerEvent; vet: string; product: string | null; occurred_at: Date; source: string; notes: string | null }[]>`
    SELECT e.id, e.event_type, u.name AS vet, p.name AS product, e.occurred_at, e.source, e.notes
    FROM vet_events e JOIN users u ON u.id = e.user_id LEFT JOIN products p ON p.id = e.product_id
    ORDER BY e.occurred_at DESC LIMIT ${limit}`;
}

// ---------------------------------------------------------------------------
// Feedback-for-discount offers
// ---------------------------------------------------------------------------

export interface OfferRow {
  id: string; user_id: string; product: string | null; discount_percent: number; status: "open" | "completed" | "not_eligible";
  expires_at: Date; using_product: boolean | null; rating: number | null; comment: string | null; discount_code: string | null;
  completed_at: Date | null; created_at: Date; vet: string; rule: string | null;
}

export async function getOfferForUser(actor: Actor, id: string): Promise<OfferRow> {
  if (!isUuid(id)) throw new NotFoundError("Offer not found.");
  const [o] = await sql<OfferRow[]>`
    SELECT f.*, p.product_family AS product, u.name AS vet, r.name AS rule
    FROM feedback_offers f JOIN users u ON u.id = f.user_id LEFT JOIN products p ON p.id = f.product_id LEFT JOIN reminder_rules r ON r.id = f.rule_id
    WHERE f.id = ${id}`;
  if (!o || o.user_id !== actor.userId) throw new NotFoundError("Offer not found.");
  return o;
}

function discountCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return `BC-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

/**
 * Short feedback. A veterinarian who uses the product now gets a discount code for the next order;
 * otherwise the feedback is still recorded. Only the offer's own veterinarian can answer, once.
 */
export async function submitOfferFeedback(actor: Actor, id: string, input: { usingProduct: string | null; rating: number | null; comment: string | null }): Promise<OfferRow> {
  const offer = await getOfferForUser(actor, id);
  if (offer.status !== "open") throw new ValidationError("You already answered this.");
  if (offer.expires_at.getTime() < Date.now()) throw new ValidationError("This offer has expired.");
  if (input.usingProduct !== "yes" && input.usingProduct !== "no") throw new ValidationError("Tell us whether you are using the product now.");
  if (input.rating == null || !Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new ValidationError("Choose a rating from 1 to 5.");
  const comment = input.comment?.slice(0, 2000) ?? null;
  if (!comment || comment.length < 3) throw new ValidationError("Write a few words of feedback.");
  const using = input.usingProduct === "yes";
  const code = using ? discountCode() : null;
  await sql.begin(async (tx) => {
    const [u] = await tx`
      UPDATE feedback_offers SET status = ${using ? "completed" : "not_eligible"}, using_product = ${using}, rating = ${input.rating},
        comment = ${comment}, discount_code = ${code}, completed_at = now()
      WHERE id = ${id} AND status = 'open' RETURNING id`;
    if (!u) throw new ValidationError("You already answered this.");
    await audit(actor, { action: "feedback_offer.submit", entityType: "feedback_offer", entityId: id, tool: "ui", inputSummary: using ? "discount issued" : "not using the product" }, tx);
  });
  if (code) {
    const [me] = await sql<{ email: string; name: string }[]>`SELECT email, name FROM users WHERE id = ${actor.userId}`;
    try {
      await sendEmail({
        to: me.email,
        subject: `Your ${offer.discount_percent}% BioChange discount code`,
        text: `Hello ${me.name.split(/\s+/)[0]},\n\nThank you for your feedback${offer.product ? ` on ${offer.product}` : ""}.\n\nYour discount code: ${code}\n${offer.discount_percent}% off your next order. Mention the code when you order from BioChange or your distributor.\n\nBioChange Vet Companion`,
        from: env().MARKETING_EMAIL_FROM || undefined,
        replyTo: env().EMAIL_REPLY_TO || undefined,
      });
    } catch (err) {
      log.error("feedback_offer.email_failed", { err });
    }
  }
  return getOfferForUser(actor, id);
}

export async function listOffers(limit = 200) {
  return sql<OfferRow[]>`
    SELECT f.*, p.product_family AS product, u.name AS vet, r.name AS rule
    FROM feedback_offers f JOIN users u ON u.id = f.user_id LEFT JOIN products p ON p.id = f.product_id LEFT JOIN reminder_rules r ON r.id = f.rule_id
    ORDER BY coalesce(f.completed_at, f.created_at) DESC LIMIT ${limit}`;
}

export async function engagementCounts() {
  const [c] = await sql<{ rules: number; active_rules: number; sent_7d: number; pending: number; failed: number; offers_open: number; codes_issued: number }[]>`
    SELECT
      (SELECT count(*)::int FROM reminder_rules) AS rules,
      (SELECT count(*)::int FROM reminder_rules WHERE active) AS active_rules,
      (SELECT count(*)::int FROM outbound_emails WHERE status = 'sent' AND sent_at > now() - interval '7 days') AS sent_7d,
      (SELECT count(*)::int FROM outbound_emails WHERE status IN ('pending', 'sending')) AS pending,
      (SELECT count(*)::int FROM outbound_emails WHERE status = 'failed') AS failed,
      (SELECT count(*)::int FROM feedback_offers WHERE status = 'open' AND expires_at > now()) AS offers_open,
      (SELECT count(*)::int FROM feedback_offers WHERE discount_code IS NOT NULL) AS codes_issued`;
  return c;
}
