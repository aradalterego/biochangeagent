import "server-only";
import { sql } from "@/lib/db";
import { isClinicRole } from "@/lib/roles";
import type { Actor } from "@/lib/authz";
import { followUpsForClinic } from "./cases";
import { estimateInventory } from "./inventory";
import { getAdoptionState } from "./adoption";

export interface TodayCard {
  kind: "follow_up_overdue" | "follow_up_today" | "follow_up_upcoming" | "inventory_low" | "draft_order" | "support_answer" | "first_use" | "training";
  title: string;
  detail: string;
  href: string;
  priority: number; // lower = more important
}

/**
 * Proactive items shown when the vet opens the app. Only genuinely useful events —
 * this is never a promotional feed.
 */
export async function getTodayCards(actor: Actor, timezone = "UTC"): Promise<TodayCard[]> {
  const cards: TodayCard[] = [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });

  if (isClinicRole(actor.role) && actor.clinicId) {
    const fus = await followUpsForClinic(actor);
    for (const f of fus) {
      const due = f.due_at.toISOString().slice(0, 10);
      const label = `${f.product ?? "Case"}${f.tooth ? ` · tooth ${f.tooth}` : ""}${f.patient ? ` · ${f.patient}` : ""}`;
      const daysAhead = (Date.parse(due) - Date.parse(today)) / 864e5;
      if (due < today) cards.push({ kind: "follow_up_overdue", title: "Overdue follow-up", detail: `${label} — was due ${due}`, href: `/cases/${f.case_id}`, priority: 1 });
      else if (due === today) cards.push({ kind: "follow_up_today", title: "Follow-up due today", detail: label, href: `/cases/${f.case_id}`, priority: 2 });
      else if (daysAhead <= 7) cards.push({ kind: "follow_up_upcoming", title: "Upcoming follow-up", detail: `${label} — ${due}`, href: `/cases/${f.case_id}`, priority: 5 });
    }

    for (const s of await estimateInventory(actor)) {
      if (s.likelyLow) {
        cards.push({
          kind: "inventory_low",
          title: `${s.product} may be running low`,
          detail: `Estimated stock: ${s.estimatedStock ?? "unknown"} unit(s)${s.weeksUntilStockOut != null ? ` (~${s.weeksUntilStockOut} weeks at recent usage)` : ""}. Based on recorded usage — please confirm.`,
          href: "/inventory",
          priority: 3,
        });
      }
    }

    const drafts = await sql<{ id: string; quantity: number; name: string }[]>`
      SELECT o.id, o.quantity, p.name FROM orders o JOIN products p ON p.id = o.product_id
      WHERE o.clinic_id = ${actor.clinicId} AND o.status = 'draft' ORDER BY o.created_at DESC LIMIT 3`;
    for (const d of drafts) {
      cards.push({ kind: "draft_order", title: "Draft order waiting for confirmation", detail: `${d.quantity} package(s) of ${d.name}`, href: "/orders", priority: 4 });
    }

    const adoption = await getAdoptionState(actor.userId);
    if (adoption.state === "first_use_pending") {
      cards.push({ kind: "first_use", title: "Planning your first case?", detail: "Ask the companion for the approved protocol, or save the case so follow-up is tracked.", href: "/chat?prompt=first-case", priority: 6 });
    }
  }

  const answers = await sql<{ id: string; question: string }[]>`
    SELECT id, question FROM medical_support_requests WHERE user_id = ${actor.userId} AND status = 'answered' AND answer_seen_at IS NULL
    ORDER BY answered_at DESC LIMIT 3`;
  for (const a of answers) {
    cards.push({ kind: "support_answer", title: "Medical Support answered your question", detail: a.question.slice(0, 140), href: `/support/${a.id}`, priority: 2 });
  }

  const [training] = await sql<{ id: string; title: string }[]>`
    SELECT r.id, r.title FROM education_activity a JOIN education_resources r ON r.id = a.resource_id
    WHERE a.user_id = ${actor.userId} AND r.counts_as_training AND r.active
      AND NOT EXISTS (SELECT 1 FROM education_activity b WHERE b.user_id = a.user_id AND b.resource_id = a.resource_id AND b.completed)
    ORDER BY a.opened_at DESC LIMIT 1`;
  if (training) cards.push({ kind: "training", title: "Continue training", detail: training.title, href: "/education", priority: 7 });

  return cards.sort((a, b) => a.priority - b.priority).slice(0, 8);
}
