"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession, assertBioChangeAdmin, assertKnowledgeManager, ValidationError } from "@/lib/authz";
import { num, runAction, str, type ActionState } from "@/lib/actions";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblems } from "@/lib/auth/password";
import { ROLES, type Role } from "@/lib/roles";
import { approveSource, createSource, reparseSource, revokeSource, updateSource, upsertStudy, type SourceInput } from "@/server/knowledge/sources";
import { SOURCE_TYPES, type SourceType } from "@/server/knowledge/constants";
import { saveClaim } from "@/server/knowledge/claims";
import { convertToKnowledge, setEscalationStatus, type EscalationStatus } from "@/server/domain/escalations";
import { resolveKnowledgeGap } from "@/server/domain/gaps";

/** Every admin action requires a BioChange staff role (domain services re-check). */
async function staff() {
  const actor = actorFromSession(await requireUser());
  assertKnowledgeManager(actor);
  return actor;
}

function sourceInputFrom(fd: FormData): SourceInput {
  const type = str(fd, "source_type") as SourceType;
  if (!SOURCE_TYPES.includes(type)) throw new ValidationError("Choose a source type.");
  return {
    title: str(fd, "title") ?? "",
    sourceType: type,
    product: str(fd, "product"),
    authorityLevel: num(fd, "authority_level"),
    sourceUrl: str(fd, "source_url"),
    publicationDate: str(fd, "publication_date"),
    version: str(fd, "version"),
    countryOrMarket: str(fd, "country_or_market"),
    regulatoryStatus: str(fd, "regulatory_status"),
    clinicalOrCommercial: (str(fd, "clinical_or_commercial") as SourceInput["clinicalOrCommercial"]) ?? "clinical",
    tags: (str(fd, "tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    effectiveFrom: str(fd, "effective_from"),
    effectiveUntil: str(fd, "effective_until"),
    supersedesSourceId: str(fd, "supersedes_source_id"),
    notes: str(fd, "notes"),
  };
}

export async function createSourceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  let id = "";
  const res = await runAction(async () => {
    const file = fd.get("file");
    const hasFile = file instanceof File && file.size > 0;
    const input = sourceInputFrom(fd);
    if (!hasFile && !input.sourceUrl) throw new ValidationError("Upload a file or enter an approved URL.");
    id = await createSource(actor, input, {
      file: hasFile ? { name: (file as File).name, data: Buffer.from(await (file as File).arrayBuffer()) } : undefined,
      fetchUrl: !hasFile && fd.get("fetch_url") === "on",
    });
  });
  if (id) redirect(`/admin/knowledge/${id}`);
  return res;
}

export async function updateSourceAction(id: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    const extracted = fd.get("extracted_text");
    await updateSource(actor, id, { ...sourceInputFrom(fd), extractedText: typeof extracted === "string" ? extracted.replace(/\r\n/g, "\n") : null });
  });
  revalidatePath(`/admin/knowledge/${id}`);
  return r;
}

export async function uploadSourceFileAction(id: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  let newId = "";
  const r = await runAction(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file.");
    const [s] = await sql<{ title: string; source_type: SourceType; product: string | null; authority_level: number; country_or_market: string; tags: string[]; is_placeholder: boolean }[]>`
      SELECT title, source_type, product, authority_level, country_or_market, tags, is_placeholder FROM knowledge_sources WHERE id = ${id}`;
    if (!s) throw new ValidationError("Source not found");
    // A new upload is a new version: it supersedes this record once approved.
    newId = await createSource(actor, {
      title: s.title, sourceType: s.source_type, product: s.product, authorityLevel: s.authority_level, countryOrMarket: s.country_or_market,
      tags: s.tags.filter((t) => t !== "placeholder"), version: str(fd, "version"), supersedesSourceId: s.is_placeholder ? null : id,
      notes: s.is_placeholder ? "Uploaded for a placeholder record." : `New version of source ${id}.`,
    }, { file: { name: file.name, data: Buffer.from(await file.arrayBuffer()) } });
    if (s.is_placeholder) {
      await sql`UPDATE knowledge_sources SET status = 'superseded', notes = concat_ws(E'\n', notes, ${`Replaced by uploaded source ${newId}`}::text), updated_at = now() WHERE id = ${id}`;
    }
  });
  if (newId) redirect(`/admin/knowledge/${newId}`);
  return r;
}

export async function approveSourceAction(id: string, _p: ActionState): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    const res = await approveSource(actor, id);
    return `Approved and indexed: ${res.chunks} passages${res.embedded ? " (semantic + keyword search)" : " (keyword search only — set OPENAI_API_KEY and run kb:reindex for semantic search)"}.`;
  });
  revalidatePath(`/admin/knowledge/${id}`);
  revalidatePath("/admin/knowledge");
  return r;
}

export async function revokeSourceAction(id: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    await revokeSource(actor, id, str(fd, "reason"));
    return "Revoked and removed from retrieval.";
  });
  revalidatePath(`/admin/knowledge/${id}`);
  return r;
}

export async function reparseSourceAction(id: string, _p: ActionState): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    await reparseSource(actor, id);
    return "Content re-extracted. Review it before approving.";
  });
  revalidatePath(`/admin/knowledge/${id}`);
  return r;
}

export async function addLinkedDocumentAction(parentId: string, url: string, _p: ActionState): Promise<ActionState> {
  const actor = await staff();
  let id = "";
  const r = await runAction(async () => {
    const [parent] = await sql<{ product: string | null }[]>`SELECT product FROM knowledge_sources WHERE id = ${parentId}`;
    id = await createSource(actor, {
      title: decodeURIComponent(url.split("/").pop() ?? "Linked document").replace(/[-_]+/g, " ").replace(/\.pdf$/i, ""),
      sourceType: "product_page", product: parent?.product ?? null, sourceUrl: url, tags: ["linked-document"],
      notes: `Found on source ${parentId}. Set the correct source type and authority level before approving.`,
    }, { fetchUrl: true });
  });
  if (id) redirect(`/admin/knowledge/${id}`);
  return r;
}

export async function saveStudyAction(id: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    await upsertStudy(actor, id, {
      publication: str(fd, "publication"), authors: str(fd, "authors"), journal: str(fd, "journal"), year: num(fd, "year"),
      study_design: str(fd, "study_design"), sample_size: str(fd, "sample_size"), intervention: str(fd, "intervention"), control: str(fd, "control"),
      outcomes: str(fd, "outcomes"), limitations: str(fd, "limitations"), funding_conflicts: str(fd, "funding_conflicts"),
      key_approved_claims: (str(fd, "key_approved_claims") ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
    });
  });
  revalidatePath(`/admin/knowledge/${id}`);
  return r;
}

export async function saveClaimAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    await saveClaim(actor, {
      id: str(fd, "id"), claim: str(fd, "claim") ?? "", product: str(fd, "product") ?? "", claimType: str(fd, "claim_type") ?? "",
      market: str(fd, "market"), sourceId: str(fd, "source_id"), allowedContext: str(fd, "allowed_context"),
      restrictedWording: str(fd, "restricted_wording"), status: (str(fd, "status") as "draft" | "approved" | "retired") ?? "draft",
    });
  });
  revalidatePath("/admin/claims");
  return r;
}

export async function escalationAction(id: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    await setEscalationStatus(actor, id, str(fd, "status") as EscalationStatus, str(fd, "answer"));
  });
  revalidatePath(`/admin/escalations/${id}`);
  return r;
}

export async function convertEscalationAction(id: string, _p: ActionState): Promise<ActionState> {
  const actor = await staff();
  let sourceId = "";
  const r = await runAction(async () => {
    sourceId = await convertToKnowledge(actor, id);
  });
  if (sourceId) redirect(`/admin/knowledge/${sourceId}`);
  return r;
}

export async function gapAction(id: string, status: "resolved" | "dismissed", _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    await resolveKnowledgeGap(actor, id, status, str(fd, "source_id"));
  });
  revalidatePath("/admin/gaps");
  return r;
}

// ----- Accounts (BioChange Admin) -----

export async function createClinicAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    assertBioChangeAdmin(actor);
    const name = str(fd, "name");
    if (!name) throw new ValidationError("Clinic name is required.");
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO clinics (name, country, timezone, distributor_id, estimated_dental_cases_per_month)
      VALUES (${name}, ${str(fd, "country")}, ${str(fd, "timezone") ?? "UTC"}, ${str(fd, "distributor_id")}, ${num(fd, "estimated_dental_cases_per_month")})
      RETURNING id`;
    await audit(actor, { action: "clinic.create", entityType: "clinic", entityId: c.id, tool: "admin", inputSummary: name });
    return "Clinic created.";
  });
  revalidatePath("/admin/accounts");
  return r;
}

export async function createUserAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    assertBioChangeAdmin(actor);
    const email = str(fd, "email")?.toLowerCase();
    const name = str(fd, "name");
    const role = str(fd, "role") as Role;
    const password = str(fd, "password") ?? "";
    const clinicId = str(fd, "clinic_id");
    if (!email || !name) throw new ValidationError("Name and email are required.");
    if (!ROLES.includes(role)) throw new ValidationError("Invalid role.");
    if ((role === "veterinarian" || role === "clinic_admin") && !clinicId) throw new ValidationError("Clinic users need a clinic.");
    const problem = passwordProblems(password);
    if (problem) throw new ValidationError(problem);
    const [exists] = await sql`SELECT 1 FROM users WHERE email = ${email}`;
    if (exists) throw new ValidationError("A user with this email already exists.");
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, role, clinic_id, professional_title, country, timezone, password_hash)
      VALUES (${email}, ${name}, ${role}, ${role === "veterinarian" || role === "clinic_admin" ? clinicId : null}, ${str(fd, "professional_title")},
              ${str(fd, "country")}, ${str(fd, "timezone") ?? "UTC"}, ${await hashPassword(password)})
      RETURNING id`;
    if (role === "veterinarian" || role === "clinic_admin") await sql`INSERT INTO veterinarian_profiles (user_id) VALUES (${u.id})`;
    await audit(actor, { action: "user.create", entityType: "user", entityId: u.id, tool: "admin", inputSummary: `${role} ${email}` });
    return "User created. Share the temporary password securely.";
  });
  revalidatePath("/admin/accounts");
  return r;
}

export async function setUserActiveAction(userId: string, active: boolean, _p: ActionState): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    assertBioChangeAdmin(actor);
    if (userId === actor.userId) throw new ValidationError("You cannot deactivate yourself.");
    await sql`UPDATE users SET active = ${active} WHERE id = ${userId}`;
    if (!active) await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await audit(actor, { action: active ? "user.activate" : "user.deactivate", entityType: "user", entityId: userId, tool: "admin" });
    return active ? "Activated." : "Deactivated.";
  });
  revalidatePath("/admin/accounts");
  return r;
}

export async function saveProductAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await staff();
  const r = await runAction(async () => {
    assertBioChangeAdmin(actor);
    const id = str(fd, "id");
    const values = {
      name: str(fd, "name") ?? "", product_family: str(fd, "product_family") ?? "", variant: str(fd, "variant"), sku: str(fd, "sku") ?? "",
      form: str(fd, "form"), units_per_package: num(fd, "units_per_package") ?? 1, market: str(fd, "market") ?? "global",
      active: fd.get("active") === "on", is_placeholder_sku: fd.get("is_placeholder_sku") === "on",
    };
    if (!values.name || !values.product_family || !values.sku) throw new ValidationError("Name, family and SKU are required.");
    if (!Number.isInteger(values.units_per_package) || values.units_per_package < 1) throw new ValidationError("Units per package must be ≥ 1.");
    const [row] = id
      ? await sql<{ id: string }[]>`UPDATE products SET ${sql(values)} WHERE id = ${id} RETURNING id`
      : await sql<{ id: string }[]>`INSERT INTO products ${sql(values)} RETURNING id`;
    await audit(actor, { action: id ? "product.update" : "product.create", entityType: "product", entityId: row.id, tool: "admin", inputSummary: `${values.name} ${values.sku}` });
  });
  revalidatePath("/admin/products");
  return r;
}
