import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { assertClinicRead, requireClinic, ValidationError, type Actor } from "@/lib/authz";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  professional_title: string | null;
  country: string | null;
  timezone: string;
  preferred_language: string;
  clinic_id: string | null;
  clinic_name: string | null;
  specialty: string | null;
  years_in_practice: number | null;
  dental_experience_level: string | null;
  regenerative_dentistry_experience: string | null;
  regum_training_status: string | null;
  microfoam_training_status: string | null;
  preferred_answer_depth: string | null;
  veterinary_license: string | null;
  notes: string | null;
}

export async function getUserProfile(userId: string): Promise<UserProfile> {
  const [p] = await sql<UserProfile[]>`
    SELECT u.id, u.name, u.email, u.role, u.professional_title, u.country, u.timezone, u.preferred_language, u.clinic_id,
           c.name AS clinic_name, vp.specialty, vp.years_in_practice, vp.dental_experience_level, vp.regenerative_dentistry_experience,
           vp.regum_training_status, vp.microfoam_training_status, vp.preferred_answer_depth, vp.veterinary_license, vp.notes
    FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id LEFT JOIN veterinarian_profiles vp ON vp.user_id = u.id
    WHERE u.id = ${userId}`;
  return p;
}

export interface ProfilePatch {
  professionalTitle?: string | null;
  specialty?: string | null;
  yearsInPractice?: number | null;
  dentalExperienceLevel?: "none" | "basic" | "intermediate" | "advanced" | "specialist" | null;
  regenerativeDentistryExperience?: "none" | "some" | "experienced" | null;
  regumTrainingStatus?: "not_started" | "in_progress" | "completed" | null;
  microfoamTrainingStatus?: "not_started" | "in_progress" | "completed" | null;
  preferredAnswerDepth?: "concise" | "balanced" | "detailed" | null;
  timezone?: string | null;
  notes?: string | null;
}

const ENUMS: Partial<Record<keyof ProfilePatch, readonly string[]>> = {
  dentalExperienceLevel: ["none", "basic", "intermediate", "advanced", "specialist"],
  regenerativeDentistryExperience: ["none", "some", "experienced"],
  regumTrainingStatus: ["not_started", "in_progress", "completed"],
  microfoamTrainingStatus: ["not_started", "in_progress", "completed"],
  preferredAnswerDepth: ["concise", "balanced", "detailed"],
};

/** Updates only the actor's own profile, only with whitelisted fields. */
export async function updateUserProfile(actor: Actor, patch: ProfilePatch, ctx: OpContext = {}): Promise<UserProfile> {
  for (const [k, allowed] of Object.entries(ENUMS)) {
    const v = patch[k as keyof ProfilePatch];
    if (v != null && !allowed!.includes(String(v))) throw new ValidationError(`Invalid value for ${k}`);
  }
  if (patch.yearsInPractice != null && (patch.yearsInPractice < 0 || patch.yearsInPractice > 70)) throw new ValidationError("Invalid years in practice");
  if (patch.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: patch.timezone });
    } catch {
      throw new ValidationError("Unknown timezone");
    }
  }
  const vp: Record<string, unknown> = {};
  const map: [keyof ProfilePatch, string][] = [
    ["specialty", "specialty"], ["yearsInPractice", "years_in_practice"], ["dentalExperienceLevel", "dental_experience_level"],
    ["regenerativeDentistryExperience", "regenerative_dentistry_experience"], ["regumTrainingStatus", "regum_training_status"],
    ["microfoamTrainingStatus", "microfoam_training_status"], ["preferredAnswerDepth", "preferred_answer_depth"], ["notes", "notes"],
  ];
  for (const [k, col] of map) if (patch[k] !== undefined && patch[k] !== null) vp[col] = patch[k];
  await sql.begin(async (tx) => {
    if (patch.professionalTitle != null || patch.timezone) {
      await tx`UPDATE users SET professional_title = coalesce(${patch.professionalTitle ?? null}, professional_title),
               timezone = coalesce(${patch.timezone ?? null}, timezone) WHERE id = ${actor.userId}`;
    }
    if (Object.keys(vp).length) {
      await tx`INSERT INTO veterinarian_profiles ${tx({ user_id: actor.userId, ...vp })}
               ON CONFLICT (user_id) DO UPDATE SET ${tx(vp)}, updated_at = now()`;
    }
    await audit(actor, { action: "profile.update", entityType: "user", entityId: actor.userId, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: JSON.stringify(patch) }, tx);
  });
  return getUserProfile(actor.userId);
}

export async function getClinic(actor: Actor, clinicId?: string) {
  const id = clinicId ?? requireClinic(actor);
  assertClinicRead(actor, id);
  const [c] = await sql`
    SELECT c.*, d.name AS distributor_name, d.ordering_email, d.ordering_url, d.ordering_notes
    FROM clinics c LEFT JOIN distributors d ON d.id = c.distributor_id WHERE c.id = ${id}`;
  return c;
}

export async function getClinicSummary(actor: Actor) {
  const clinicId = requireClinic(actor);
  const [s] = await sql<{ active_cases: number; follow_ups_due: number; follow_ups_overdue: number; draft_orders: number; open_orders: number; vets: number }[]>`
    SELECT
      (SELECT count(*)::int FROM cases WHERE clinic_id = ${clinicId} AND status <> 'closed') AS active_cases,
      (SELECT count(*)::int FROM follow_ups f JOIN cases c ON c.id = f.case_id WHERE c.clinic_id = ${clinicId} AND f.status = 'scheduled'
         AND f.due_at <= current_date + 7) AS follow_ups_due,
      (SELECT count(*)::int FROM follow_ups f JOIN cases c ON c.id = f.case_id WHERE c.clinic_id = ${clinicId} AND f.status = 'scheduled'
         AND f.due_at < current_date) AS follow_ups_overdue,
      (SELECT count(*)::int FROM orders WHERE clinic_id = ${clinicId} AND status = 'draft') AS draft_orders,
      (SELECT count(*)::int FROM orders WHERE clinic_id = ${clinicId} AND status IN ('submitted', 'confirmed', 'shipped')) AS open_orders,
      (SELECT count(*)::int FROM users WHERE clinic_id = ${clinicId} AND active) AS vets`;
  return { clinic: await getClinic(actor, clinicId), ...s };
}
