import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { assertClinicWrite, ValidationError, type Actor } from "@/lib/authz";
import { getCaseRow } from "./cases";
import { resolveProduct } from "./products";

/** Structured product and usability feedback on a case (kept separate from free-text notes so it can be analysed). */

export const FEEDBACK_PHASES = ["treatment", "follow_up", "general"] as const;
export type FeedbackPhase = (typeof FEEDBACK_PHASES)[number];
export const WOULD_USE_AGAIN = ["yes", "no", "unsure"] as const;

export interface FeedbackInput {
  phase?: FeedbackPhase | null;
  product?: string | null;
  productRating?: number | null;
  easeOfUseRating?: number | null;
  wouldUseAgain?: (typeof WOULD_USE_AGAIN)[number] | null;
  productFeedback?: string | null;
  usabilityFeedback?: string | null;
  handlingNotes?: string | null;
}

export interface FeedbackRow {
  id: string;
  case_id: string;
  phase: FeedbackPhase;
  product_name: string | null;
  product_rating: number | null;
  ease_of_use_rating: number | null;
  would_use_again: string | null;
  product_feedback: string | null;
  usability_feedback: string | null;
  handling_notes: string | null;
  source: "ui" | "chat";
  author: string | null;
  created_at: Date;
}

function rating(v: number | null | undefined, label: string): number | null {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 1 || v > 5) throw new ValidationError(`${label} must be a whole number from 1 to 5.`);
  return v;
}

function text(v: string | null | undefined): string | null {
  const t = v?.trim() ?? "";
  if (t.length > 4000) throw new ValidationError("Feedback text is limited to 4000 characters.");
  return t || null;
}

export async function recordCaseFeedback(actor: Actor, caseId: string, input: FeedbackInput, ctx: OpContext & { source?: "ui" | "chat" } = {}): Promise<{ id: string }> {
  const c = await getCaseRow(actor, caseId);
  assertClinicWrite(actor, c.clinic_id);
  const phase = input.phase ?? "treatment";
  if (!FEEDBACK_PHASES.includes(phase)) throw new ValidationError("Unknown feedback phase.");
  if (input.wouldUseAgain && !WOULD_USE_AGAIN.includes(input.wouldUseAgain)) throw new ValidationError("would_use_again must be yes, no or unsure.");
  const values = {
    productRating: rating(input.productRating, "Product rating"),
    easeOfUseRating: rating(input.easeOfUseRating, "Ease-of-use rating"),
    productFeedback: text(input.productFeedback),
    usabilityFeedback: text(input.usabilityFeedback),
    handlingNotes: text(input.handlingNotes),
  };
  if (values.productRating == null && values.easeOfUseRating == null && !input.wouldUseAgain && !values.productFeedback && !values.usabilityFeedback && !values.handlingNotes) {
    throw new ValidationError("Feedback is empty.");
  }
  const productId = input.product ? (await resolveProduct(input.product)).id : c.product_id;
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO case_feedback (case_id, author_id, phase, product_id, product_rating, ease_of_use_rating, would_use_again,
        product_feedback, usability_feedback, handling_notes, source)
      VALUES (${caseId}, ${actor.userId}, ${phase}, ${productId}, ${values.productRating}, ${values.easeOfUseRating}, ${input.wouldUseAgain ?? null},
        ${values.productFeedback}, ${values.usabilityFeedback}, ${values.handlingNotes}, ${ctx.source ?? "ui"})
      RETURNING id`;
    await tx`UPDATE cases SET updated_at = now() WHERE id = ${caseId}`;
    await audit(actor, { action: "case.feedback", entityType: "case", entityId: caseId, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId, inputSummary: phase }, tx);
    return row;
  });
}
