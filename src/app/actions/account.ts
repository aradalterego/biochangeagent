"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { num, runAction, str, type ActionState } from "@/lib/actions";
import { updateUserProfile, type ProfilePatch } from "@/server/domain/profile";
import { forgetMemory } from "@/server/domain/memory";
import { recordTrainingActivity } from "@/server/domain/education";
import { createMedicalSupportRequest } from "@/server/domain/escalations";

export async function updateProfileAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await updateUserProfile(actorFromSession(user), {
      professionalTitle: str(fd, "professional_title"),
      specialty: str(fd, "specialty"),
      yearsInPractice: num(fd, "years_in_practice"),
      dentalExperienceLevel: str(fd, "dental_experience_level") as ProfilePatch["dentalExperienceLevel"],
      regenerativeDentistryExperience: str(fd, "regenerative_dentistry_experience") as ProfilePatch["regenerativeDentistryExperience"],
      preferredAnswerDepth: str(fd, "preferred_answer_depth") as ProfilePatch["preferredAnswerDepth"],
      timezone: str(fd, "timezone"),
    }, { tool: "ui" });
  });
  revalidatePath("/profile");
  return r;
}

export async function forgetMemoryAction(id: string, _p: ActionState): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await forgetMemory(actorFromSession(user), id);
    return "Forgotten.";
  });
  revalidatePath("/profile");
  return r;
}

export async function trainingAction(resourceId: string, completed: boolean, _p: ActionState): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await recordTrainingActivity(actorFromSession(user), resourceId, completed);
    return completed ? "Marked as completed." : "Recorded.";
  });
  revalidatePath("/education");
  return r;
}

export async function askMedicalSupportAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    const res = await createMedicalSupportRequest(actorFromSession(user), {
      question: str(fd, "question") ?? "",
      product: str(fd, "product"),
      urgency: (str(fd, "urgency") as "normal") ?? "normal",
      agentSummary: "Submitted directly from the Medical Support page.",
    }, { tool: "ui" });
    return `Sent to BioChange Medical Support (reference ${res.id.slice(0, 8)}).`;
  });
  revalidatePath("/support");
  return r;
}
