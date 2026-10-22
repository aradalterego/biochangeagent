"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession, assertBioChangeAdmin, ValidationError } from "@/lib/authz";
import { num, runAction, str, type ActionState } from "@/lib/actions";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { deleteFile, putFile, sanitizeFileName, type FileKind } from "@/lib/storage";
import {
  composeEmail, deleteRule, deleteTemplate, logEventFromAdmin, runEngagementJobs, saveRule, saveTemplate, setRuleActive, submitOfferFeedback,
  type Audience,
} from "@/server/domain/engagement";

/** Reminder rules, templates, emails and marketing materials are managed by BioChange Admins only. */
async function admin() {
  const actor = actorFromSession(await requireUser());
  assertBioChangeAdmin(actor);
  return actor;
}

function ruleInput(fd: FormData, id: string | null) {
  return {
    id,
    name: str(fd, "name"),
    reminderType: str(fd, "reminder_type"),
    triggerEvent: str(fd, "trigger_event"),
    productId: str(fd, "product_id"),
    delayDays: num(fd, "delay_days"),
    repeatEveryDays: num(fd, "repeat_every_days"),
    maxSends: num(fd, "max_sends"),
    audience: str(fd, "audience"),
    templateId: str(fd, "template_id"),
    subject: str(fd, "subject"),
    body: str(fd, "body"),
    offerDiscount: fd.get("offer_discount") === "on",
    discountPercent: num(fd, "discount_percent"),
    offerValidDays: num(fd, "offer_valid_days"),
    appliesFrom: str(fd, "applies_from"),
    active: fd.get("active") === "on",
  };
}

export async function createRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    await saveRule(actor, ruleInput(fd, null));
    return "Reminder rule created.";
  });
  revalidatePath("/admin/reminders");
  return r;
}

export async function updateRuleAction(id: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    await saveRule(actor, ruleInput(fd, id));
    return "Saved.";
  });
  revalidatePath("/admin/reminders");
  revalidatePath(`/admin/reminders/${id}`);
  return r;
}

export async function setRuleActiveAction(id: string, active: boolean, _p: ActionState): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    await setRuleActive(actor, id, active);
    return active ? "Rule active." : "Rule paused.";
  });
  revalidatePath("/admin/reminders");
  return r;
}

export async function deleteRuleAction(id: string, _p: ActionState): Promise<ActionState> {
  const actor = await admin();
  let done = false;
  const r = await runAction(async () => {
    await deleteRule(actor, id);
    done = true;
  });
  if (done) {
    revalidatePath("/admin/reminders");
    redirect("/admin/reminders");
  }
  return r;
}

/** Runs the reminder rules now instead of waiting for the daily job. */
export async function runRulesNowAction(_p: ActionState): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    const res = await runEngagementJobs();
    await audit(actor, { action: "reminder_rules.run", entityType: "reminder_rule", tool: "admin", inputSummary: `${res.enqueued} queued, ${res.sent} sent, ${res.failed} failed` });
    return `${res.enqueued} email(s) queued, ${res.sent} sent${res.failed ? `, ${res.failed} failed` : ""}.`;
  });
  revalidatePath("/admin/reminders");
  return r;
}

export async function logEventAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    await logEventFromAdmin(actor, { userId: str(fd, "user_id"), type: str(fd, "event_type"), productId: str(fd, "product_id"), occurredAt: str(fd, "occurred_at"), notes: str(fd, "notes") });
    return "Event recorded. Matching reminder rules will send on schedule.";
  });
  revalidatePath("/admin/reminders/events");
  return r;
}

export async function saveTemplateAction(id: string | null, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    await saveTemplate(actor, { id, name: str(fd, "name"), subject: str(fd, "subject"), body: str(fd, "body") });
    return id ? "Template saved." : "Template created.";
  });
  revalidatePath("/admin/reminders/templates");
  return r;
}

export async function deleteTemplateAction(id: string, _p: ActionState): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    await deleteTemplate(actor, id);
    return "Template deleted.";
  });
  revalidatePath("/admin/reminders/templates");
  return r;
}

export async function composeEmailAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    const audience = (str(fd, "audience") ?? "selected") as "selected" | Audience;
    if (!["selected", "all", "customers", "non_customers"].includes(audience)) throw new ValidationError("Choose recipients.");
    const res = await composeEmail(actor, {
      audience,
      userIds: fd.getAll("user_ids").filter((v): v is string => typeof v === "string"),
      country: str(fd, "country"),
      productId: str(fd, "product_id"),
      subject: str(fd, "subject"),
      body: str(fd, "body"),
      templateId: str(fd, "template_id"),
    });
    if (fd.get("save_as_template") === "on") {
      await saveTemplate(actor, { name: str(fd, "template_name") ?? str(fd, "subject"), subject: str(fd, "subject"), body: str(fd, "body") });
    }
    const later = res.queued - res.sent - res.failed;
    return `${res.queued} email(s): ${res.sent} sent${res.failed ? `, ${res.failed} failed (will retry)` : ""}${later > 0 ? `, ${later} queued for the next run` : ""}.`;
  });
  revalidatePath("/admin/reminders/compose");
  return r;
}

// ----- Feedback offers (veterinarian side) -----

export async function submitOfferAction(id: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = actorFromSession(await requireUser());
  const r = await runAction(async () => {
    const o = await submitOfferFeedback(actor, id, { usingProduct: str(fd, "using_product"), rating: num(fd, "rating"), comment: str(fd, "comment") });
    return o.discount_code ? `Thank you! Your discount code: ${o.discount_code}` : "Thank you for your feedback.";
  });
  revalidatePath(`/offers/${id}`);
  return r;
}

// ----- Marketing materials -----

const MARKETING_KINDS: FileKind[] = ["pdf", "png", "jpeg", "webp", "pptx", "docx", "xlsx", "mp4", "zip"];
const MAX_MARKETING_FILE = 20 * 1024 * 1024;

export async function uploadMarketingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    const title = str(fd, "title");
    const file = fd.get("file");
    if (!title) throw new ValidationError("Enter a title.");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file.");
    const productId = str(fd, "product_id");
    const name = sanitizeFileName(file.name);
    // Marketing images are kept as uploaded (no re-encoding) so print quality is preserved; they are only served as downloads.
    const stored = await putFile("marketing", Buffer.from(await file.arrayBuffer()), MARKETING_KINDS, MAX_MARKETING_FILE, { fileName: name });
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO marketing_materials (title, description, category, product_id, storage_path, file_name, mime_type, size_bytes, sort_order, created_by)
      VALUES (${title}, ${str(fd, "description")}, ${str(fd, "category")}, ${productId}, ${stored.storagePath}, ${name}, ${stored.mimeType}, ${stored.size},
              ${num(fd, "sort_order") ?? 0}, ${actor.userId})
      RETURNING id`;
    await audit(actor, { action: "marketing.upload", entityType: "marketing_material", entityId: m.id, tool: "admin", inputSummary: title });
    return "Uploaded. Veterinarians can download it next to the chat.";
  });
  revalidatePath("/admin/marketing");
  return r;
}

export async function setMarketingActiveAction(id: string, active: boolean, _p: ActionState): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    await sql`UPDATE marketing_materials SET active = ${active} WHERE id = ${id}`;
    await audit(actor, { action: active ? "marketing.publish" : "marketing.hide", entityType: "marketing_material", entityId: id, tool: "admin" });
    return active ? "Visible to veterinarians." : "Hidden from veterinarians.";
  });
  revalidatePath("/admin/marketing");
  return r;
}

export async function deleteMarketingAction(id: string, _p: ActionState): Promise<ActionState> {
  const actor = await admin();
  const r = await runAction(async () => {
    const [m] = await sql<{ storage_path: string; title: string }[]>`DELETE FROM marketing_materials WHERE id = ${id} RETURNING storage_path, title`;
    if (!m) throw new ValidationError("Not found.");
    await deleteFile(m.storage_path);
    await audit(actor, { action: "marketing.delete", entityType: "marketing_material", entityId: id, tool: "admin", inputSummary: m.title });
    return "Deleted.";
  });
  revalidatePath("/admin/marketing");
  return r;
}
