import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { assertClinicRead, assertClinicWrite, NotFoundError, requireClinic, ValidationError, type Actor } from "@/lib/authz";
import { resolveProduct } from "./products";
import { recomputeAdoption } from "./adoption";

export const CASE_STATUSES = ["discussion", "planned", "treated", "follow_up_due", "followed_up", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface CaseRow {
  id: string;
  clinic_id: string;
  created_by: string | null;
  created_by_name?: string | null;
  internal_patient_identifier: string | null;
  species: string;
  breed: string | null;
  age: string | null;
  tooth: string | null;
  condition_summary: string | null;
  pocket_depth_mm: string | null;
  defect_type: string | null;
  furcation: string | null;
  procedure_type: string | null;
  treatment_goal: string | null;
  product_id: string | null;
  product_name?: string | null;
  product_variant: string | null;
  treatment_date: Date | null;
  status: CaseStatus;
  baseline_notes: string | null;
  follow_up_date: Date | null;
  outcome_notes: string | null;
  created_at: Date;
  updated_at: Date;
  next_follow_up?: Date | null;
}

export interface CaseInput {
  internalPatientIdentifier?: string | null;
  species?: string | null;
  breed?: string | null;
  age?: string | null;
  tooth?: string | null;
  conditionSummary?: string | null;
  pocketDepthMm?: number | null;
  defectType?: string | null;
  furcation?: string | null;
  procedureType?: string | null;
  treatmentGoal?: string | null;
  product?: string | null; // name / sku / id — resolved server-side
  productVariant?: string | null;
  treatmentDate?: string | null;
  status?: CaseStatus | null;
  baselineNotes?: string | null;
  followUpDate?: string | null;
  outcomeNotes?: string | null;
}

const CASE_SELECT = () => sql`
  SELECT c.*, p.name AS product_name, u.name AS created_by_name,
    (SELECT min(f.due_at) FROM follow_ups f WHERE f.case_id = c.id AND f.status = 'scheduled') AS next_follow_up
  FROM cases c
  LEFT JOIN products p ON p.id = c.product_id
  LEFT JOIN users u ON u.id = c.created_by`;

export async function searchCases(
  actor: Actor,
  q: { query?: string | null; status?: string | null; tooth?: string | null; limit?: number } = {},
): Promise<CaseRow[]> {
  const clinicId = actor.role === "biochange_admin" && !actor.clinicId ? null : requireClinic(actor);
  const like = q.query?.trim() ? `%${q.query.trim().replace(/[%_]/g, "")}%` : null;
  return sql<CaseRow[]>`
    ${CASE_SELECT()}
    WHERE c.clinic_id = ${clinicId}
      AND (${q.status ?? null}::text IS NULL OR c.status = ${q.status ?? null})
      AND (${q.tooth ?? null}::text IS NULL OR c.tooth = ${q.tooth ?? null})
      AND (${like}::text IS NULL OR concat_ws(' ', c.internal_patient_identifier, c.tooth, c.condition_summary, c.breed,
            c.procedure_type, c.defect_type, p.name, c.baseline_notes, c.outcome_notes) ILIKE ${like})
    ORDER BY c.updated_at DESC
    LIMIT ${Math.min(q.limit ?? 50, 200)}`;
}

export async function getCaseRow(actor: Actor, id: string): Promise<CaseRow> {
  if (!isUuid(id)) throw new NotFoundError("Case not found");
  const [row] = await sql<CaseRow[]>`${CASE_SELECT()} WHERE c.id = ${id}`;
  if (!row) throw new NotFoundError("Case not found");
  assertClinicRead(actor, row.clinic_id);
  return row;
}

export async function getCase(actor: Actor, id: string) {
  const c = await getCaseRow(actor, id);
  const [notes, followUps, measurements, files, conversations, usage] = await Promise.all([
    sql`SELECT n.id, n.content, n.created_at, u.name AS author FROM case_notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.case_id = ${id} ORDER BY n.created_at`,
    sql`SELECT * FROM follow_ups WHERE case_id = ${id} ORDER BY due_at`,
    sql`SELECT * FROM case_measurements WHERE case_id = ${id} ORDER BY measured_at, created_at`,
    sql`SELECT id, file_type, file_name, mime_type, size_bytes, description, uploaded_at, follow_up_id FROM case_files
        WHERE case_id = ${id} ORDER BY uploaded_at`,
    sql`SELECT cv.id, cv.title, cv.last_message_at FROM case_conversations cc JOIN conversations cv ON cv.id = cc.conversation_id
        WHERE cc.case_id = ${id} AND cv.user_id = ${actor.userId} ORDER BY cv.last_message_at DESC`,
    sql`SELECT e.quantity, e.created_at, p.name AS product FROM inventory_events e JOIN products p ON p.id = e.product_id
        WHERE e.case_id = ${id} AND e.event_type = 'usage' ORDER BY e.created_at`,
  ]);
  return { case: c, notes, followUps, measurements, files, conversations, usage };
}

function validate(input: CaseInput) {
  if (input.pocketDepthMm != null && (input.pocketDepthMm < 0 || input.pocketDepthMm > 30)) {
    throw new ValidationError("Pocket depth must be between 0 and 30 mm.");
  }
  if (input.status && !CASE_STATUSES.includes(input.status)) throw new ValidationError("Unknown case status.");
  for (const d of [input.treatmentDate, input.followUpDate]) {
    if (d && Number.isNaN(Date.parse(d))) throw new ValidationError(`Invalid date: ${d}`);
  }
}

export async function createCase(actor: Actor, input: CaseInput, ctx: OpContext & { conversationId?: string | null } = {}): Promise<CaseRow> {
  const clinicId = requireClinic(actor);
  validate(input);
  const product = input.product ? await resolveProduct(input.product) : null;
  const today = await clinicToday(clinicId);
  const id = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO cases (clinic_id, created_by, internal_patient_identifier, species, breed, age, tooth, condition_summary,
        pocket_depth_mm, defect_type, furcation, procedure_type, treatment_goal, product_id, product_variant, treatment_date,
        status, baseline_notes, follow_up_date)
      VALUES (${clinicId}, ${actor.userId}, ${input.internalPatientIdentifier ?? null}, ${input.species || "dog"}, ${input.breed ?? null},
        ${input.age ?? null}, ${input.tooth ?? null}, ${input.conditionSummary ?? null}, ${input.pocketDepthMm ?? null},
        ${input.defectType ?? null}, ${input.furcation ?? null}, ${input.procedureType ?? null}, ${input.treatmentGoal ?? null},
        ${product?.id ?? null}, ${input.productVariant ?? product?.variant ?? null}, ${input.treatmentDate || null},
        ${input.status ?? (input.treatmentDate ? "treated" : "discussion")}, ${input.baselineNotes ?? null}, ${input.followUpDate || null})
      RETURNING id`;
    if (input.pocketDepthMm != null || input.furcation) {
      await tx`INSERT INTO case_measurements (case_id, kind, measured_at, tooth, pocket_depth_mm, furcation, notes, recorded_by)
               VALUES (${row.id}, 'baseline', ${input.treatmentDate || today}, ${input.tooth ?? null},
                       ${input.pocketDepthMm ?? null}, ${input.furcation ?? null}, ${input.baselineNotes ?? null}, ${actor.userId})`;
    }
    if (input.followUpDate) {
      await tx`INSERT INTO follow_ups (case_id, due_at, reason, created_by) VALUES (${row.id}, ${input.followUpDate}, 'Post-treatment follow-up', ${actor.userId})`;
    }
    if (ctx.conversationId) {
      await tx`INSERT INTO case_conversations (case_id, conversation_id) VALUES (${row.id}, ${ctx.conversationId}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE conversations SET active_case_id = ${row.id} WHERE id = ${ctx.conversationId} AND user_id = ${actor.userId}`;
    }
    await audit(actor, { action: "case.create", entityType: "case", entityId: row.id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: summarize(input) }, tx);
    return row.id;
  });
  return getCaseRow(actor, id);
}

export async function updateCase(actor: Actor, id: string, input: CaseInput, ctx: OpContext = {}): Promise<CaseRow> {
  const existing = await getCaseRow(actor, id);
  assertClinicWrite(actor, existing.clinic_id);
  validate(input);
  const product = input.product ? await resolveProduct(input.product) : null;
  const set: Record<string, unknown> = {};
  const map: [keyof CaseInput, string][] = [
    ["internalPatientIdentifier", "internal_patient_identifier"], ["species", "species"], ["breed", "breed"], ["age", "age"],
    ["tooth", "tooth"], ["conditionSummary", "condition_summary"], ["pocketDepthMm", "pocket_depth_mm"], ["defectType", "defect_type"],
    ["furcation", "furcation"], ["procedureType", "procedure_type"], ["treatmentGoal", "treatment_goal"],
    ["productVariant", "product_variant"], ["treatmentDate", "treatment_date"], ["status", "status"],
    ["baselineNotes", "baseline_notes"], ["followUpDate", "follow_up_date"], ["outcomeNotes", "outcome_notes"],
  ];
  for (const [k, col] of map) if (input[k] !== undefined) set[col] = input[k] === "" ? null : input[k];
  // status and species are required columns: "(automatic)" / blank means "leave unchanged".
  for (const col of ["status", "species"]) if (set[col] == null) delete set[col];
  if (product) set.product_id = product.id;
  if (!Object.keys(set).length) return existing;
  await sql.begin(async (tx) => {
    // A follow-up date is a scheduled follow-up, not just a field.
    if (set.follow_up_date) {
      await tx`INSERT INTO follow_ups (case_id, due_at, reason, created_by)
               SELECT ${id}, ${set.follow_up_date as string}, 'Follow-up', ${actor.userId}
               WHERE NOT EXISTS (SELECT 1 FROM follow_ups WHERE case_id = ${id} AND status = 'scheduled' AND due_at = ${set.follow_up_date as string})`;
      delete set.follow_up_date;
    }
    if (Object.keys(set).length) await tx`UPDATE cases SET ${tx(set)}, updated_at = now() WHERE id = ${id}`;
    await tx`UPDATE cases SET follow_up_date = (SELECT min(due_at) FROM follow_ups WHERE case_id = ${id} AND status = 'scheduled'), updated_at = now() WHERE id = ${id}`;
    // Baseline pocket depth recorded for the first time becomes a baseline measurement.
    if (input.pocketDepthMm != null && existing.pocket_depth_mm == null) {
      await tx`INSERT INTO case_measurements (case_id, kind, measured_at, tooth, pocket_depth_mm, recorded_by)
               VALUES (${id}, 'baseline', ${existing.treatment_date ? existing.treatment_date.toISOString().slice(0, 10) : await clinicToday(existing.clinic_id)}, ${input.tooth ?? existing.tooth}, ${input.pocketDepthMm}, ${actor.userId})`;
    }
    await audit(actor, { action: "case.update", entityType: "case", entityId: id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: Object.keys(set).join(", ") }, tx);
  });
  return getCaseRow(actor, id);
}

export async function closeCase(actor: Actor, id: string, outcomeNotes: string | null, ctx: OpContext = {}): Promise<CaseRow> {
  const existing = await getCaseRow(actor, id);
  assertClinicWrite(actor, existing.clinic_id);
  await sql.begin(async (tx) => {
    await tx`UPDATE cases SET status = 'closed', outcome_notes = coalesce(${outcomeNotes}, outcome_notes), follow_up_date = NULL, updated_at = now() WHERE id = ${id}`;
    await tx`UPDATE follow_ups SET status = 'cancelled' WHERE case_id = ${id} AND status = 'scheduled'`;
    await audit(actor, { action: "case.close", entityType: "case", entityId: id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId, inputSummary: outcomeNotes }, tx);
  });
  return getCaseRow(actor, id);
}

export async function addCaseNote(actor: Actor, caseId: string, content: string, ctx: OpContext = {}): Promise<{ id: string }> {
  const c = await getCaseRow(actor, caseId);
  assertClinicWrite(actor, c.clinic_id);
  if (!content?.trim()) throw new ValidationError("Note is empty.");
  return sql.begin(async (tx) => {
    const [n] = await tx<{ id: string }[]>`INSERT INTO case_notes (case_id, author_id, content) VALUES (${caseId}, ${actor.userId}, ${content.trim()}) RETURNING id`;
    await tx`UPDATE cases SET updated_at = now() WHERE id = ${caseId}`;
    await audit(actor, { action: "case.add_note", entityType: "case", entityId: caseId, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId, inputSummary: content }, tx);
    return n;
  });
}

export async function scheduleFollowUp(actor: Actor, caseId: string, dueAt: string, reason: string | null, ctx: OpContext = {}) {
  const c = await getCaseRow(actor, caseId);
  assertClinicWrite(actor, c.clinic_id);
  if (!dueAt || Number.isNaN(Date.parse(dueAt))) throw new ValidationError("A valid follow-up date is required (YYYY-MM-DD).");
  return sql.begin(async (tx) => {
    const [f] = await tx<{ id: string; due_at: Date }[]>`
      INSERT INTO follow_ups (case_id, due_at, reason, created_by) VALUES (${caseId}, ${dueAt}, ${reason}, ${actor.userId}) RETURNING id, due_at`;
    await tx`UPDATE cases SET follow_up_date = (SELECT min(due_at) FROM follow_ups WHERE case_id = ${caseId} AND status = 'scheduled'),
             updated_at = now() WHERE id = ${caseId}`;
    await audit(actor, { action: "follow_up.schedule", entityType: "follow_up", entityId: f.id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: `case ${caseId} due ${dueAt}${reason ? `: ${reason}` : ""}` }, tx);
    return f;
  });
}

export interface FollowUpResult {
  pocketDepthMm?: number | null;
  attachmentLevelMm?: number | null;
  mobility?: string | null;
  furcation?: string | null;
  notes?: string | null;
  outcome?: string | null;
}

/** Records a follow-up as a separate measurement row so the baseline is preserved. */
export async function completeFollowUp(actor: Actor, followUpId: string, result: FollowUpResult, ctx: OpContext = {}) {
  if (!isUuid(followUpId)) throw new NotFoundError("Follow-up not found");
  const [f] = await sql<{ id: string; case_id: string; status: string }[]>`SELECT id, case_id, status FROM follow_ups WHERE id = ${followUpId}`;
  if (!f) throw new NotFoundError("Follow-up not found");
  const c = await getCaseRow(actor, f.case_id);
  assertClinicWrite(actor, c.clinic_id);
  if (f.status !== "scheduled") throw new ValidationError(`This follow-up is already ${f.status}.`);
  if (result.pocketDepthMm != null && (result.pocketDepthMm < 0 || result.pocketDepthMm > 30)) throw new ValidationError("Pocket depth must be between 0 and 30 mm.");
  await sql.begin(async (tx) => {
    await tx`UPDATE follow_ups SET status = 'completed', completed_at = now(), notes = ${result.notes ?? null} WHERE id = ${followUpId}`;
    await tx`INSERT INTO case_measurements (case_id, kind, follow_up_id, tooth, pocket_depth_mm, attachment_level_mm, mobility, furcation, notes, recorded_by)
             VALUES (${f.case_id}, 'follow_up', ${followUpId}, ${c.tooth}, ${result.pocketDepthMm ?? null}, ${result.attachmentLevelMm ?? null},
                     ${result.mobility ?? null}, ${result.furcation ?? null}, ${result.notes ?? null}, ${actor.userId})`;
    await tx`UPDATE cases SET status = CASE WHEN status = 'closed' THEN status ELSE 'followed_up' END,
             outcome_notes = coalesce(${result.outcome ?? null}, outcome_notes),
             follow_up_date = (SELECT min(due_at) FROM follow_ups WHERE case_id = ${f.case_id} AND status = 'scheduled'),
             updated_at = now() WHERE id = ${f.case_id}`;
    await audit(actor, { action: "follow_up.complete", entityType: "follow_up", entityId: followUpId, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: `case ${f.case_id}; PD ${result.pocketDepthMm ?? "n/a"} mm; ${result.outcome ?? result.notes ?? ""}` }, tx);
  });
  await recomputeAdoption(actor.userId);
  return getCase(actor, f.case_id);
}

export async function followUpsForClinic(actor: Actor) {
  const clinicId = requireClinic(actor);
  return sql<{ id: string; case_id: string; due_at: Date; reason: string | null; tooth: string | null; patient: string | null; product: string | null }[]>`
    SELECT f.id, f.case_id, f.due_at, f.reason, c.tooth, c.internal_patient_identifier AS patient, p.name AS product
    FROM follow_ups f JOIN cases c ON c.id = f.case_id LEFT JOIN products p ON p.id = c.product_id
    WHERE c.clinic_id = ${clinicId} AND f.status = 'scheduled'
    ORDER BY f.due_at`;
}

export function linkConversation(caseId: string, conversationId: string) {
  return sql`INSERT INTO case_conversations (case_id, conversation_id) VALUES (${caseId}, ${conversationId}) ON CONFLICT DO NOTHING`;
}

/** Today's date (YYYY-MM-DD) in the clinic's timezone. */
export async function clinicToday(clinicId: string | null): Promise<string> {
  const [r] = await sql<{ d: string }[]>`
    SELECT to_char(now() AT TIME ZONE coalesce((SELECT timezone FROM clinics WHERE id = ${clinicId}), 'UTC'), 'YYYY-MM-DD') AS d`;
  return r.d;
}

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function summarize(input: CaseInput): string {
  return Object.entries(input)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
