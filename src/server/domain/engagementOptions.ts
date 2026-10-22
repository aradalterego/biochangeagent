import "server-only";
import { sql } from "@/lib/db";
import { AUDIENCE_LABELS, AUDIENCES, MERGE_TAGS, REMINDER_TYPE_LABELS, REMINDER_TYPES, TRIGGER_EVENTS, TRIGGER_LABELS, listTemplates } from "./engagement";

/** Select options shared by the reminder-rule forms. */
export async function ruleFormOptions() {
  const [products, templates] = await Promise.all([
    sql<{ id: string; name: string }[]>`SELECT id, name FROM products WHERE active ORDER BY name`,
    listTemplates(),
  ]);
  return {
    types: REMINDER_TYPES.map((v) => ({ value: v, label: REMINDER_TYPE_LABELS[v] })),
    triggers: TRIGGER_EVENTS.map((v) => ({ value: v, label: TRIGGER_LABELS[v] })),
    audiences: AUDIENCES.map((v) => ({ value: v, label: AUDIENCE_LABELS[v] })),
    products: products.map((p) => ({ value: p.id, label: p.name })),
    templates: templates.map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body })),
    mergeTags: MERGE_TAGS,
  };
}
