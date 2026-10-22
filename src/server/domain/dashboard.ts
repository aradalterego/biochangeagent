import "server-only";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertBioChangeReader, type Actor } from "@/lib/authz";
import { isUuid } from "./cases";

/**
 * BioChange clinical dashboard: read-only, cross-clinic view of veterinarians, cases,
 * follow-up state and structured feedback. Every function checks the BioChange role
 * server-side; all filters are parameterised and sort keys are whitelisted.
 */

export const FOLLOW_UP_STATES = ["overdue", "missing", "scheduled", "completed", "not_due"] as const;
export type FollowUpState = (typeof FOLLOW_UP_STATES)[number];

export interface CaseFilters {
  q?: string | null;
  status?: string | null;
  productId?: string | null;
  clinicId?: string | null;
  vetId?: string | null;
  followUp?: FollowUpState | null;
  treatedFrom?: string | null;
  treatedTo?: string | null;
  /** Which date the from/to range applies to (default: treatment date). */
  dateField?: "treatment" | "created" | null;
  country?: string | null;
  sort?: string | null;
  dir?: "asc" | "desc" | null;
  page?: number | null;
}

export interface DashboardCaseRow {
  id: string;
  status: string;
  species: string;
  tooth: string | null;
  condition_summary: string | null;
  defect_type: string | null;
  procedure_type: string | null;
  pocket_depth_mm: string | null;
  product_name: string | null;
  product_variant: string | null;
  treatment_date: Date | null;
  created_at: Date;
  last_activity_at: Date;
  clinic_id: string;
  clinic_name: string;
  clinic_country: string | null;
  country: string | null;
  vet_id: string | null;
  vet_name: string | null;
  next_follow_up: Date | null;
  last_follow_up_completed: Date | null;
  follow_up_state: FollowUpState;
  feedback_count: number;
  avg_product_rating: string | null;
  avg_ease_rating: string | null;
  file_count: number;
  baseline_pd: string | null;
  latest_follow_up_pd: string | null;
  outcome_notes: string | null;
  total: number;
}

const SORTS: Record<string, string> = {
  activity: "last_activity_at",
  created: "created_at",
  treatment: "treatment_date",
  status: "status",
  clinic: "clinic_name",
  vet: "vet_name",
  follow_up: "next_follow_up",
};

export const PAGE_SIZE = 50;

function dateOrNull(s: string | null | undefined): string | null {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

/** One row per case with derived follow-up state and feedback aggregates. */
function caseRows() {
  return sql`
    SELECT c.id, c.status, c.species, c.tooth, c.condition_summary, c.defect_type, c.procedure_type, c.pocket_depth_mm,
      p.name AS product_name, c.product_variant, c.treatment_date, c.created_at, c.outcome_notes,
      greatest(c.updated_at, coalesce(cv.last_message_at, c.updated_at)) AS last_activity_at,
      cl.id AS clinic_id, cl.name AS clinic_name, cl.country AS clinic_country, coalesce(cl.country, u.country) AS country,
      u.id AS vet_id, u.name AS vet_name,
      fu.next_due AS next_follow_up, fu.last_completed AS last_follow_up_completed,
      CASE
        WHEN fu.n_overdue > 0 THEN 'overdue'
        WHEN fu.n_scheduled > 0 THEN 'scheduled'
        WHEN fu.n_completed > 0 THEN 'completed'
        WHEN c.status <> 'closed' AND (c.treatment_date IS NOT NULL OR c.status IN ('treated', 'follow_up_due')) THEN 'missing'
        ELSE 'not_due'
      END AS follow_up_state,
      coalesce(fb.n, 0)::int AS feedback_count, round(fb.avg_product, 1)::text AS avg_product_rating, round(fb.avg_ease, 1)::text AS avg_ease_rating,
      (SELECT count(*)::int FROM case_files f WHERE f.case_id = c.id AND f.deleted_at IS NULL) AS file_count,
      (SELECT m.pocket_depth_mm FROM case_measurements m WHERE m.case_id = c.id AND m.kind = 'baseline' ORDER BY m.measured_at, m.created_at LIMIT 1) AS baseline_pd,
      (SELECT m.pocket_depth_mm FROM case_measurements m WHERE m.case_id = c.id AND m.kind = 'follow_up' ORDER BY m.measured_at DESC, m.created_at DESC LIMIT 1) AS latest_follow_up_pd
    FROM cases c
    JOIN clinics cl ON cl.id = c.clinic_id
    LEFT JOIN users u ON u.id = c.created_by
    LEFT JOIN products p ON p.id = c.product_id
    LEFT JOIN LATERAL (
      SELECT min(due_at) FILTER (WHERE status = 'scheduled') AS next_due,
             count(*) FILTER (WHERE status = 'scheduled') AS n_scheduled,
             count(*) FILTER (WHERE status = 'scheduled' AND due_at < current_date) AS n_overdue,
             count(*) FILTER (WHERE status = 'completed') AS n_completed,
             max(completed_at) AS last_completed
      FROM follow_ups WHERE case_id = c.id) fu ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, avg(product_rating) AS avg_product, avg(ease_of_use_rating) AS avg_ease FROM case_feedback WHERE case_id = c.id) fb ON true
    LEFT JOIN LATERAL (
      SELECT max(v.last_message_at) AS last_message_at FROM case_conversations cc JOIN conversations v ON v.id = cc.conversation_id
      WHERE cc.case_id = c.id) cv ON true`;
}

function whereClause(f: CaseFilters) {
  const like = f.q?.trim() ? `%${f.q.trim().slice(0, 100).replace(/[%_\\]/g, "")}%` : null;
  const status = f.status?.trim() || null;
  const productId = isUuid(f.productId) ? f.productId : null;
  const clinicId = isUuid(f.clinicId) ? f.clinicId : null;
  const vetId = isUuid(f.vetId) ? f.vetId : null;
  const followUp = f.followUp && FOLLOW_UP_STATES.includes(f.followUp) ? f.followUp : null;
  const from = dateOrNull(f.treatedFrom);
  const to = dateOrNull(f.treatedTo);
  const country = f.country?.trim().slice(0, 100) || null;
  const dateCol = f.dateField === "created" ? sql`r.created_at::date` : sql`r.treatment_date`;
  return sql`
    WHERE (${status}::text IS NULL OR r.status = ${status})
      AND (${productId}::uuid IS NULL OR r.id IN (SELECT id FROM cases WHERE product_id = ${productId}))
      AND (${clinicId}::uuid IS NULL OR r.clinic_id = ${clinicId})
      AND (${vetId}::uuid IS NULL OR r.vet_id = ${vetId})
      AND (${followUp}::text IS NULL OR r.follow_up_state = ${followUp})
      AND (${from}::date IS NULL OR ${dateCol} >= ${from}::date)
      AND (${to}::date IS NULL OR ${dateCol} <= ${to}::date)
      AND (${country}::text IS NULL OR r.country = ${country})
      AND (${like}::text IS NULL OR concat_ws(' ', r.tooth, r.condition_summary, r.defect_type, r.procedure_type, r.product_name,
            r.clinic_name, r.vet_name, r.species) ILIKE ${like})`;
}

export async function listDashboardCases(actor: Actor, f: CaseFilters): Promise<{ rows: DashboardCaseRow[]; total: number; page: number }> {
  assertBioChangeReader(actor);
  const col = SORTS[f.sort ?? ""] ?? SORTS.activity;
  const dir = f.dir === "asc" ? sql`ASC` : sql`DESC`;
  const page = Math.max(1, Math.min(10_000, Math.floor(f.page ?? 1)));
  const rows = await sql<DashboardCaseRow[]>`
    SELECT r.*, count(*) OVER ()::int AS total FROM (${caseRows()}) r
    ${whereClause(f)}
    ORDER BY ${sql(col)} ${dir} NULLS LAST, r.id
    LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  return { rows, total: rows[0]?.total ?? 0, page };
}

export async function dashboardFilterOptions(actor: Actor) {
  assertBioChangeReader(actor);
  const [clinics, vets, products, countries] = await Promise.all([
    sql<{ id: string; name: string }[]>`SELECT id, name FROM clinics ORDER BY name`,
    sql<{ id: string; name: string; clinic: string | null }[]>`
      SELECT u.id, u.name, c.name AS clinic FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id
      WHERE u.role IN ('veterinarian', 'clinic_admin') ORDER BY u.name`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM products ORDER BY name`,
    sql<{ country: string }[]>`
      SELECT DISTINCT country FROM (SELECT country FROM clinics UNION SELECT country FROM users WHERE role IN ('veterinarian', 'clinic_admin')) x
      WHERE country IS NOT NULL AND country <> '' ORDER BY country`,
  ]);
  return { clinics, vets, products, countries: countries.map((c) => c.country) };
}

export async function dashboardOverview(actor: Actor) {
  assertBioChangeReader(actor);
  const [totals] = await sql<{
    vets: number; active_vets_30d: number; vets_with_cases: number; cases: number; treated_30d: number;
    overdue: number; missing: number; feedback: number; avg_product: string | null; avg_ease: string | null;
  }[]>`
    WITH r AS (${caseRows()})
    SELECT
      (SELECT count(*)::int FROM users WHERE role IN ('veterinarian', 'clinic_admin') AND active) AS vets,
      (SELECT count(*)::int FROM users WHERE role IN ('veterinarian', 'clinic_admin') AND last_active_at > now() - interval '30 days') AS active_vets_30d,
      (SELECT count(DISTINCT vet_id)::int FROM r) AS vets_with_cases,
      (SELECT count(*)::int FROM r) AS cases,
      (SELECT count(*)::int FROM r WHERE treatment_date > current_date - 30) AS treated_30d,
      (SELECT count(*)::int FROM r WHERE follow_up_state = 'overdue') AS overdue,
      (SELECT count(*)::int FROM r WHERE follow_up_state = 'missing') AS missing,
      (SELECT count(*)::int FROM case_feedback) AS feedback,
      (SELECT round(avg(product_rating), 1)::text FROM case_feedback) AS avg_product,
      (SELECT round(avg(ease_of_use_rating), 1)::text FROM case_feedback) AS avg_ease`;
  const byStatus = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM cases GROUP BY status ORDER BY n DESC`;
  const recent = await sql<DashboardCaseRow[]>`
    SELECT r.*, 0 AS total FROM (${caseRows()}) r ORDER BY r.last_activity_at DESC LIMIT 10`;
  return { totals, byStatus, recent };
}

export interface VetFilters {
  q?: string | null;
  productId?: string | null;
  country?: string | null;
  customer?: "yes" | "no" | null;
  from?: string | null;
  to?: string | null;
}

export interface DashboardVetRow {
  id: string; name: string; email: string; title: string | null; is_customer: boolean; active: boolean; created_at: Date;
  clinic_id: string | null; clinic: string | null; country: string | null; last_login_at: Date | null; last_active_at: Date | null;
  cases: number; open_cases: number; overdue: number; missing: number; feedback: number; purchases: number; usage_questions: number;
}

/**
 * Veterinarians with case, follow-up and feedback counts. Product and date filters narrow the counts
 * to that product / period, and (when set) list only veterinarians with activity for it.
 */
export async function listDashboardVets(actor: Actor, f: VetFilters = {}): Promise<DashboardVetRow[]> {
  assertBioChangeReader(actor);
  const productId = isUuid(f.productId) ? f.productId : null;
  const country = f.country?.trim().slice(0, 100) || null;
  const customer = f.customer === "yes" ? true : f.customer === "no" ? false : null;
  const from = dateOrNull(f.from);
  const to = dateOrNull(f.to);
  const like = f.q?.trim() ? `%${f.q.trim().slice(0, 100).replace(/[%_\\]/g, "")}%` : null;
  const ranged = from || to;
  return sql<DashboardVetRow[]>`
    WITH r AS (
      SELECT * FROM (${caseRows()}) x
      WHERE (${productId}::uuid IS NULL OR x.id IN (SELECT id FROM cases WHERE product_id = ${productId}))
        AND (${from}::date IS NULL OR coalesce(x.treatment_date, x.created_at::date) >= ${from}::date)
        AND (${to}::date IS NULL OR coalesce(x.treatment_date, x.created_at::date) <= ${to}::date)),
    ev AS (
      SELECT * FROM vet_events e
      WHERE (${productId}::uuid IS NULL OR e.product_id = ${productId})
        AND (${from}::date IS NULL OR e.occurred_at::date >= ${from}::date)
        AND (${to}::date IS NULL OR e.occurred_at::date <= ${to}::date))
    SELECT u.id, u.name, u.email, u.professional_title AS title, u.is_customer, u.active, u.created_at, u.clinic_id, c.name AS clinic,
      coalesce(u.country, c.country) AS country, u.last_login_at, u.last_active_at,
      (SELECT count(*)::int FROM r WHERE r.vet_id = u.id) AS cases,
      (SELECT count(*)::int FROM r WHERE r.vet_id = u.id AND r.status <> 'closed') AS open_cases,
      (SELECT count(*)::int FROM r WHERE r.vet_id = u.id AND r.follow_up_state = 'overdue') AS overdue,
      (SELECT count(*)::int FROM r WHERE r.vet_id = u.id AND r.follow_up_state = 'missing') AS missing,
      (SELECT count(*)::int FROM case_feedback f WHERE f.author_id = u.id
         AND (${productId}::uuid IS NULL OR f.product_id = ${productId} OR f.case_id IN (SELECT id FROM cases WHERE product_id = ${productId}))
         AND (${from}::date IS NULL OR f.created_at::date >= ${from}::date) AND (${to}::date IS NULL OR f.created_at::date <= ${to}::date)) AS feedback,
      (SELECT count(*)::int FROM ev WHERE ev.user_id = u.id AND ev.event_type = 'purchase') AS purchases,
      (SELECT count(*)::int FROM ev WHERE ev.user_id = u.id AND ev.event_type = 'usage_question') AS usage_questions
    FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id
    WHERE u.role IN ('veterinarian', 'clinic_admin')
      AND (${country}::text IS NULL OR coalesce(u.country, c.country) = ${country})
      AND (${customer}::boolean IS NULL OR u.is_customer = ${customer})
      AND (${like}::text IS NULL OR concat_ws(' ', u.name, u.email, c.name, u.professional_title) ILIKE ${like})
      AND (${productId}::uuid IS NULL OR EXISTS (SELECT 1 FROM r WHERE r.vet_id = u.id) OR EXISTS (SELECT 1 FROM ev WHERE ev.user_id = u.id AND ev.event_type <> 'registered'))
      AND (${!ranged}::boolean OR EXISTS (SELECT 1 FROM r WHERE r.vet_id = u.id) OR EXISTS (SELECT 1 FROM ev WHERE ev.user_id = u.id)
           OR (u.last_active_at::date BETWEEN coalesce(${from}::date, '-infinity'::date) AND coalesce(${to}::date, 'infinity'::date)))
    ORDER BY u.last_active_at DESC NULLS LAST, u.name`;
}

export function vetFiltersFromParams(sp: Record<string, string | string[] | undefined>): VetFilters {
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const customer = one("customer");
  return { q: one("q"), productId: one("product"), country: one("country"), customer: customer === "yes" || customer === "no" ? customer : null, from: one("from"), to: one("to") };
}

const VET_EXPORT_COLUMNS: [string, (r: DashboardVetRow) => unknown][] = [
  ["name", (r) => r.name], ["title", (r) => r.title], ["email", (r) => r.email], ["country", (r) => r.country], ["clinic", (r) => r.clinic],
  ["customer", (r) => (r.is_customer ? "yes" : "no")], ["active", (r) => (r.active ? "yes" : "no")], ["registered", (r) => day(r.created_at)],
  ["cases", (r) => r.cases], ["open_cases", (r) => r.open_cases], ["follow_up_overdue", (r) => r.overdue], ["follow_up_missing", (r) => r.missing],
  ["feedback", (r) => r.feedback], ["purchases", (r) => r.purchases], ["usage_questions_to_agent", (r) => r.usage_questions],
  ["last_sign_in", (r) => day(r.last_login_at)], ["last_active", (r) => day(r.last_active_at)],
];

export async function exportVetsCsv(actor: Actor, f: VetFilters): Promise<{ csv: string; rows: number }> {
  const rows = await listDashboardVets(actor, f);
  const lines = [VET_EXPORT_COLUMNS.map(([h]) => h).join(",")];
  for (const r of rows) lines.push(VET_EXPORT_COLUMNS.map(([, get]) => csvCell(get(r))).join(","));
  const filterSummary = Object.entries(f).filter(([, v]) => v).map(([k]) => k).join(", ") || "none";
  await audit(actor, { action: "dashboard.export_vets", entityType: "user", tool: "ui", inputSummary: `${rows.length} rows; filters: ${filterSummary}` });
  return { csv: `${lines.join("\r\n")}\r\n`, rows: rows.length };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_COLUMNS: [string, (r: DashboardCaseRow) => unknown][] = [
  ["case_id", (r) => r.id],
  ["clinic", (r) => r.clinic_name],
  ["country", (r) => r.country],
  ["veterinarian", (r) => r.vet_name],
  ["status", (r) => r.status],
  ["species", (r) => r.species],
  ["tooth", (r) => r.tooth],
  ["condition", (r) => r.condition_summary],
  ["defect_type", (r) => r.defect_type],
  ["procedure", (r) => r.procedure_type],
  ["product", (r) => r.product_name],
  ["product_variant", (r) => r.product_variant],
  ["treatment_date", (r) => day(r.treatment_date)],
  ["baseline_pocket_depth_mm", (r) => r.baseline_pd],
  ["latest_follow_up_pocket_depth_mm", (r) => r.latest_follow_up_pd],
  ["follow_up_state", (r) => r.follow_up_state],
  ["next_follow_up", (r) => day(r.next_follow_up)],
  ["last_follow_up_completed", (r) => day(r.last_follow_up_completed)],
  ["outcome", (r) => r.outcome_notes],
  ["feedback_count", (r) => r.feedback_count],
  ["avg_product_rating", (r) => r.avg_product_rating],
  ["avg_ease_of_use_rating", (r) => r.avg_ease_rating],
  ["files", (r) => r.file_count],
  ["created_at", (r) => day(r.created_at)],
  ["last_activity_at", (r) => day(r.last_activity_at)],
];

const EXPORT_LIMIT = 10_000;

/**
 * CSV of the filtered cases for analysis. The clinic's internal patient reference and
 * free-text notes are not included; values are guarded against spreadsheet formula injection.
 */
export async function exportCasesCsv(actor: Actor, f: CaseFilters): Promise<{ csv: string; rows: number }> {
  assertBioChangeReader(actor);
  const col = SORTS[f.sort ?? ""] ?? SORTS.activity;
  const rows = await sql<DashboardCaseRow[]>`
    SELECT r.*, 0 AS total FROM (${caseRows()}) r
    ${whereClause(f)}
    ORDER BY ${sql(col)} DESC NULLS LAST, r.id
    LIMIT ${EXPORT_LIMIT}`;
  const lines = [EXPORT_COLUMNS.map(([h]) => h).join(",")];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map(([, get]) => csvCell(get(r))).join(","));
  const filterSummary = Object.entries(f).filter(([k, v]) => v && k !== "page").map(([k]) => k).join(", ") || "none";
  await audit(actor, { action: "dashboard.export", entityType: "case", tool: "ui", inputSummary: `${rows.length} rows; filters: ${filterSummary}` });
  return { csv: `${lines.join("\r\n")}\r\n`, rows: rows.length };
}

export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function day(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

export function filtersFromParams(sp: Record<string, string | string[] | undefined>): CaseFilters {
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return {
    q: one("q"),
    status: one("status"),
    productId: one("product"),
    clinicId: one("clinic"),
    vetId: one("vet"),
    followUp: one("follow_up") as FollowUpState | null,
    treatedFrom: one("from"),
    treatedTo: one("to"),
    dateField: one("date_field") === "created" ? "created" : "treatment",
    country: one("country"),
    sort: one("sort"),
    dir: one("dir") === "asc" ? "asc" : "desc",
    page: Number(one("page") ?? 1) || 1,
  };
}
