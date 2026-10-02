"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession, assertClinicWrite, ValidationError } from "@/lib/authz";
import { runAction, str, num, type ActionState } from "@/lib/actions";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { putFile } from "@/lib/storage";
import {
  addCaseNote, closeCase, completeFollowUp, createCase, getCaseRow, scheduleFollowUp, updateCase, type CaseInput, type CaseStatus,
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

export async function uploadCaseFileAction(caseId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    const actor = actorFromSession(user);
    const c = await getCaseRow(actor, caseId);
    assertClinicWrite(actor, c.clinic_id);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file.");
    const fileType = str(fd, "file_type") ?? "other";
    if (!["radiograph", "clinical_image", "document", "other"].includes(fileType)) throw new ValidationError("Invalid file type.");
    const stored = await putFile("cases", Buffer.from(await file.arrayBuffer()), ["pdf", "png", "jpeg", "webp", "dicom"], MAX_CASE_FILE);
    const name = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO case_files (case_id, file_type, storage_path, file_name, mime_type, size_bytes, description, uploaded_by)
      VALUES (${caseId}, ${fileType}, ${stored.storagePath}, ${name}, ${stored.mimeType}, ${stored.size}, ${str(fd, "description")}, ${user.id})
      RETURNING id`;
    await audit(actor, { action: "case.upload_file", entityType: "case_file", entityId: row.id, tool: "ui", inputSummary: `${fileType}: ${name}` });
    return "File uploaded.";
  });
  revalidatePath(`/cases/${caseId}`);
  return r;
}
