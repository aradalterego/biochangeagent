"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession, assertClinicWrite, ValidationError } from "@/lib/authz";
import { runAction, str, num, type ActionState } from "@/lib/actions";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { putFile, sanitizeFileName, type FileKind } from "@/lib/storage";
import { enforce } from "@/lib/rateLimit";
import { featureEnabled } from "@/lib/features";
import { recordCaseFeedback, type FeedbackInput, type FeedbackPhase } from "@/server/domain/feedback";
import {
  addCaseNote, closeCase, completeFollowUp, createCase, deleteCaseFile, getCaseRow, scheduleFollowUp, updateCase, type CaseInput, type CaseStatus,
} from "@/server/domain/cases";
import { recordProductUsage } from "@/server/domain/inventory";

function caseInputFrom(fd: FormData): CaseInput {
  return {
    internalPatientIdentifier: str(fd, "internal_patient_identifier"),
    species: str(fd, "species"),
    breed: str(fd, "breed"),
    age: str(fd, "age"),
    tooth: str(fd, "tooth"),
    conditionSummary: str(fd, "condition_summary"),
    pocketDepthMm: num(fd, "pocket_depth_mm"),
    defectType: str(fd, "defect_type"),
    furcation: str(fd, "furcation"),
    procedureType: str(fd, "procedure_type"),
    treatmentGoal: str(fd, "treatment_goal"),
    product: str(fd, "product"),
    treatmentDate: str(fd, "treatment_date"),
    status: str(fd, "status") as CaseStatus | null,
    baselineNotes: str(fd, "baseline_notes"),
    followUpDate: str(fd, "follow_up_date"),
  };
}

export async function createCaseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  let id = "";
  const res = await runAction(async () => {
    const c = await createCase(actorFromSession(user), caseInputFrom(fd), { tool: "ui" });
    id = c.id;
  });
  if (id) redirect(`/cases/${id}`);
  return res;
}

export async function updateCaseAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const input = caseInputFrom(fd);
  input.outcomeNotes = str(fd, "outcome_notes");
  const r = await runAction(async () => {
    await updateCase(actorFromSession(user), caseId, input, { tool: "ui" });
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

export async function addNoteAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await addCaseNote(actorFromSession(user), caseId, str(fd, "note") ?? "", { tool: "ui" });
    return "Note added.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

export async function scheduleFollowUpAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await scheduleFollowUp(actorFromSession(user), caseId, str(fd, "due_at") ?? "", str(fd, "reason"), { tool: "ui" });
    return "Follow-up scheduled.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

export async function completeFollowUpAction(caseId: string, followUpId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await completeFollowUp(actorFromSession(user), followUpId, {
      pocketDepthMm: num(fd, "pocket_depth_mm"),
      attachmentLevelMm: num(fd, "attachment_level_mm"),
      mobility: str(fd, "mobility"),
      furcation: str(fd, "furcation"),
      notes: str(fd, "notes"),
      outcome: str(fd, "outcome"),
    }, { tool: "ui" });
    return "Follow-up recorded.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

export async function recordUsageAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    if (!featureEnabled("inventory")) throw new ValidationError("Usage tracking is not available.");
    const res = await recordProductUsage(actorFromSession(user), { productRef: str(fd, "product") ?? "", quantity: num(fd, "quantity") ?? 1, caseId }, { tool: "ui" });
    return `Recorded. Estimated stock: ${res.estimatedStock}.`;
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

export async function closeCaseAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await closeCase(actorFromSession(user), caseId, str(fd, "outcome_notes"), { tool: "ui" });
    return "Case closed.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

const MAX_CASE_FILE = 20 * 1024 * 1024;
const FILE_TYPES = ["radiograph", "clinical_image", "document", "treatment_file", "other"] as const;
/** Every upload is untrusted input: identified by content, size-limited, images re-encoded, stored privately under a random name. */
const ALLOWED_KINDS: Record<(typeof FILE_TYPES)[number], FileKind[]> = {
  radiograph: ["png", "jpeg", "webp", "dicom", "pdf"],
  clinical_image: ["png", "jpeg", "webp"],
  document: ["pdf", "text", "csv", "xlsx"],
  treatment_file: ["pdf", "csv", "xlsx", "text"],
  other: ["pdf", "png", "jpeg", "webp", "dicom", "text", "csv", "xlsx"],
};

export async function uploadCaseFileAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    const actor = actorFromSession(user);
    const c = await getCaseRow(actor, caseId);
    assertClinicWrite(actor, c.clinic_id);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file.");
    const fileType = (str(fd, "file_type") ?? "other") as (typeof FILE_TYPES)[number];
    if (!FILE_TYPES.includes(fileType)) throw new ValidationError("Invalid file type.");
    if (file.size > MAX_CASE_FILE) throw new ValidationError("File is too large (max 20 MB).");
    await enforce(`upload:${user.id}`, 30, 3600, "Upload limit reached. Please try again later.");
    const name = sanitizeFileName(file.name);
    const stored = await putFile("cases", Buffer.from(await file.arrayBuffer()), ALLOWED_KINDS[fileType], MAX_CASE_FILE, { fileName: name, sanitizeImages: true });
    const description = str(fd, "description")?.slice(0, 500) ?? null;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO case_files (case_id, file_type, storage_path, file_name, mime_type, size_bytes, description, uploaded_by, sha256)
      VALUES (${caseId}, ${fileType}, ${stored.storagePath}, ${name}, ${stored.mimeType}, ${stored.size}, ${description}, ${user.id}, ${stored.sha256})
      RETURNING id`;
    await sql`UPDATE cases SET updated_at = now() WHERE id = ${caseId}`;
    await audit(actor, { action: "case.upload_file", entityType: "case_file", entityId: row.id, tool: "ui", inputSummary: `${fileType} (${stored.kind})` });
    return "File uploaded.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

export async function deleteCaseFileAction(caseId: string, fileId: string, _p: ActionState): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await deleteCaseFile(actorFromSession(user), fileId);
    return "File deleted.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}

export async function recordFeedbackAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await recordCaseFeedback(actorFromSession(user), caseId, {
      phase: (str(fd, "phase") as FeedbackPhase) ?? "treatment",
      productRating: num(fd, "product_rating"),
      easeOfUseRating: num(fd, "ease_of_use_rating"),
      wouldUseAgain: str(fd, "would_use_again") as FeedbackInput["wouldUseAgain"],
      productFeedback: str(fd, "product_feedback"),
      usabilityFeedback: str(fd, "usability_feedback"),
      handlingNotes: str(fd, "handling_notes"),
    }, { tool: "ui", source: "ui" });
    return "Feedback saved. Thank you.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}
