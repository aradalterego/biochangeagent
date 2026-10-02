import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { assertEscalationHandler, NotFoundError, ValidationError, type Actor } from "@/lib/authz";
import { getCaseRow } from "./cases";
import { createSource } from "@/server/knowledge/sources";

export const ESCALATION_STATUSES = ["new", "in_review", "answered", "closed"] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export interface EscalationInput {
  question: string;
  product?: string | null;
  caseId?: string | null;
  sourcesChecked?: { sourceId: string; title: string }[];
  agentSummary?: string | null;
  urgency?: "low" | "normal" | "high" | "urgent";
  conversationId?: string | null;
}

export async function createMedicalSupportRequest(actor: Actor, input: EscalationInput, ctx: OpContext = {}) {
  if (!input.question?.trim()) throw new ValidationError("The question is required.");
  if (input.caseId) await getCaseRow(actor, input.caseId); // authorisation
  const urgency = input.urgency ?? "normal";
  if (!["low", "normal", "high", "urgent"].includes(urgency)) throw new ValidationError("Invalid urgency");
  return sql.begin(async (tx) => {
    const [r] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO medical_support_requests (user_id, clinic_id, conversation_id, case_id, question, product, sources_checked, agent_summary, urgency)
      VALUES (${actor.userId}, ${actor.clinicId}, ${input.conversationId ?? null}, ${input.caseId ?? null}, ${input.question.trim()},
              ${input.product ?? null}, ${tx.json((input.sourcesChecked ?? []) as never)}, ${input.agentSummary ?? null}, ${urgency})
      RETURNING id, created_at`;
    await tx`UPDATE knowledge_gaps SET escalated = true, escalation_id = ${r.id}
             WHERE normalized_question = ${normalizeQuestion(input.question)} AND escalation_id IS NULL`;
    await audit(actor, { action: "medical_support.create", entityType: "medical_support_request", entityId: r.id, tool: ctx.tool,
      sourceMessageId: ctx.sourceMessageId, inputSummary: `[${urgency}] ${input.question}` }, tx);
    return { id: r.id, status: "new" as const, createdAt: r.created_at };
  });
}

export async function listMyRequests(actor: Actor) {
  return sql`SELECT id, question, status, answer, answered_at, answer_seen_at, created_at FROM medical_support_requests
             WHERE user_id = ${actor.userId} ORDER BY created_at DESC LIMIT 50`;
}

export async function markAnswerSeen(actor: Actor, id: string) {
  await sql`UPDATE medical_support_requests SET answer_seen_at = now() WHERE id = ${id} AND user_id = ${actor.userId} AND answer_seen_at IS NULL`;
}

export async function listEscalations(actor: Actor, status?: string | null) {
  assertEscalationHandler(actor);
  return sql`
    SELECT r.*, u.name AS user_name, u.email AS user_email, c.name AS clinic_name, a.name AS answered_by_name
    FROM medical_support_requests r JOIN users u ON u.id = r.user_id LEFT JOIN clinics c ON c.id = r.clinic_id
    LEFT JOIN users a ON a.id = r.answered_by
    WHERE (${status ?? null}::text IS NULL OR r.status = ${status ?? null})
    ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'in_review' THEN 1 WHEN 'answered' THEN 2 ELSE 3 END,
             CASE r.urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r.created_at DESC`;
}

export async function getEscalation(actor: Actor, id: string) {
  assertEscalationHandler(actor);
  const [r] = await sql`
    SELECT r.*, u.name AS user_name, u.email AS user_email, c.name AS clinic_name,
      cs.tooth AS case_tooth, cs.condition_summary AS case_condition, cs.pocket_depth_mm AS case_pocket_depth, cs.procedure_type AS case_procedure
    FROM medical_support_requests r JOIN users u ON u.id = r.user_id LEFT JOIN clinics c ON c.id = r.clinic_id
    LEFT JOIN cases cs ON cs.id = r.case_id WHERE r.id = ${id}`;
  if (!r) throw new NotFoundError("Request not found");
  return r;
}

export async function setEscalationStatus(actor: Actor, id: string, status: EscalationStatus, answer?: string | null) {
  assertEscalationHandler(actor);
  if (!ESCALATION_STATUSES.includes(status)) throw new ValidationError("Invalid status");
  if (status === "answered" && !answer?.trim()) throw new ValidationError("An answer is required.");
  await getEscalation(actor, id);
  await sql.begin(async (tx) => {
    await tx`UPDATE medical_support_requests SET status = ${status},
             answer = coalesce(${answer?.trim() || null}, answer),
             answered_by = CASE WHEN ${status} = 'answered' THEN ${actor.userId}::uuid ELSE answered_by END,
             answered_at = CASE WHEN ${status} = 'answered' THEN now() ELSE answered_at END,
             answer_seen_at = CASE WHEN ${status} = 'answered' THEN NULL ELSE answer_seen_at END,
             updated_at = now() WHERE id = ${id}`;
    await audit(actor, { action: `medical_support.${status}`, entityType: "medical_support_request", entityId: id, tool: "admin", inputSummary: answer ?? null }, tx);
  });
}

/** Turns an answered request into a PENDING REVIEW knowledge source (never auto-approved). */
export async function convertToKnowledge(actor: Actor, id: string) {
  const r = await getEscalation(actor, id);
  if (!r.answer) throw new ValidationError("Only answered requests can be converted.");
  const text = `# Medical Support answer\n\n## Question\n${r.question}\n\n## Approved answer\n${r.answer}`;
  const sourceId = await createSource(
    actor,
    {
      title: `Medical Support answer: ${String(r.question).slice(0, 80)}`,
      sourceType: "internal_approved_document",
      product: r.product,
      authorityLevel: 2,
      clinicalOrCommercial: "clinical",
      tags: ["medical-support-answer"],
      notes: `Converted from medical support request ${id}`,
    },
    { file: { name: "medical-support-answer.txt", data: Buffer.from(text, "utf8") } },
  );
  await sql`UPDATE medical_support_requests SET converted_source_id = ${sourceId}, updated_at = now() WHERE id = ${id}`;
  return sourceId;
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
