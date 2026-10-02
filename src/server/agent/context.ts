import "server-only";
import { sql } from "@/lib/db";
import { isClinicRole } from "@/lib/roles";
import { getUserProfile } from "@/server/domain/profile";
import { getMemories } from "@/server/domain/memory";
import { ADOPTION_HINTS, getAdoptionState } from "@/server/domain/adoption";
import { getCase } from "@/server/domain/cases";
import { getInventory } from "@/server/domain/inventory";
import { listProducts } from "@/server/domain/products";
import { searchKnowledge } from "@/server/knowledge/retrieve";
import { registerHits, toolDeclarations, type TurnState } from "./tools";

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const HISTORY_LIMIT = 16;

/** Small talk / acknowledgements do not need knowledge retrieval. */
function needsRetrieval(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.split(/\s+/).length < 3 && !/regum|microfoam/.test(t)) return false;
  return !/^(thanks|thank you|ok|okay|great|perfect|yes|no|sure|bye)[.! ]*$/.test(t);
}

/**
 * Builds the compact runtime context for one turn. Only what is relevant is included:
 * the active case (if any), inventory only for products in play, a handful of memories,
 * recent history and a small set of pre-retrieved approved passages.
 */
export async function buildContext(state: TurnState): Promise<{ contextBlock: string; history: HistoryMessage[] }> {
  const { actor } = state;
  const clinicUser = isClinicRole(actor.role) && Boolean(actor.clinicId);

  const [profile, memories, adoption, products, historyRows] = await Promise.all([
    getUserProfile(actor.userId),
    getMemories(actor.userId, 12),
    getAdoptionState(actor.userId),
    listProducts(),
    sql<HistoryMessage[]>`
      SELECT role, content FROM (
        SELECT role, content, created_at FROM messages
        WHERE conversation_id = ${state.conversationId} AND role IN ('user', 'assistant', 'system') AND id <> ${state.userMessageId}
        ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}) recent
      ORDER BY created_at`,
  ]);

  const [clinic] = clinicUser
    ? await sql<{ id: string; name: string; country: string | null; timezone: string; distributor: string | null }[]>`
        SELECT c.id, c.name, c.country, c.timezone, d.name AS distributor FROM clinics c LEFT JOIN distributors d ON d.id = c.distributor_id
        WHERE c.id = ${actor.clinicId}`
    : [];

  // Active case: only when this conversation is about one.
  let activeCase: unknown = null;
  let caseProduct: string | null = null;
  if (state.activeCaseId && clinicUser) {
    try {
      const c = await getCase(actor, state.activeCaseId);
      caseProduct = c.case.product_name ?? null;
      activeCase = {
        id: c.case.id, status: c.case.status, patient_ref: c.case.internal_patient_identifier, species: c.case.species, tooth: c.case.tooth,
        condition: c.case.condition_summary, pocket_depth_mm: c.case.pocket_depth_mm, defect_type: c.case.defect_type, furcation: c.case.furcation,
        procedure: c.case.procedure_type, goal: c.case.treatment_goal, product: c.case.product_name, treatment_date: c.case.treatment_date,
        next_follow_up: c.case.next_follow_up, measurements: c.measurements, recent_notes: c.notes.slice(-3),
      };
    } catch {
      state.activeCaseId = null;
    }
  }

  // Inventory only for products mentioned now, or the active case's product.
  const recentText = `${historyRows.slice(-2).map((m) => m.content).join(" ")} ${state.userText}`.toLowerCase();
  const mentioned = new Set(products.filter((p) => recentText.includes(p.product_family.toLowerCase().split(" ")[0])).map((p) => p.product_family));
  if (caseProduct) mentioned.add(products.find((p) => p.name === caseProduct)?.product_family ?? caseProduct);
  const inventoryIntent = /stock|inventory|left|order|reorder|box|package|units?\b|used/.test(recentText);
  let inventory: unknown = null;
  if (clinicUser && (mentioned.size || inventoryIntent)) {
    const lines = await getInventory(actor);
    inventory = lines
      .filter((l) => !mentioned.size || mentioned.has(l.productFamily))
      .map((l) => ({
        product: l.product, sku: l.sku, confirmed: l.quantityConfirmed, last_confirmed: l.lastConfirmedAt?.toISOString().slice(0, 10) ?? null,
        estimated: l.quantityEstimated, used_since_confirmed: l.usedSinceConfirmed, used_last_30_days: l.usedLast30Days,
      }));
  }

  // Pre-retrieve a few approved passages for professional questions.
  let knowledge: unknown[] = [];
  if (needsRetrieval(state.userText)) {
    try {
      const product = mentioned.size === 1 ? [...mentioned][0] : null;
      const hits = await searchKnowledge({ query: state.userText, product, market: profile.country, limit: 4 });
      state.knowledgeSearches.push({ query: state.userText, product, results: hits.length });
      knowledge = registerHits(state, hits);
    } catch (err) {
      console.error("[agent] pre-retrieval failed", err);
      knowledge = [];
    }
  }

  const [followUps] = clinicUser
    ? await sql<{ due_week: number; overdue: number }[]>`
        SELECT count(*) FILTER (WHERE f.due_at <= current_date + 7 AND f.due_at >= current_date)::int AS due_week,
               count(*) FILTER (WHERE f.due_at < current_date)::int AS overdue
        FROM follow_ups f JOIN cases c ON c.id = f.case_id WHERE c.clinic_id = ${actor.clinicId} AND f.status = 'scheduled'`
    : [{ due_week: 0, overdue: 0 }];

  const context = {
    now: new Date().toLocaleString("en-GB", { timeZone: profile.timezone || "UTC", dateStyle: "full", timeStyle: "short" }),
    today: new Date().toLocaleDateString("en-CA", { timeZone: profile.timezone || "UTC" }),
    channel: "web",
    user: {
      name: profile.name,
      role: profile.role,
      title: profile.professional_title,
      country: profile.country,
      language: profile.preferred_language,
      experience: {
        specialty: profile.specialty, years_in_practice: profile.years_in_practice, dental: profile.dental_experience_level,
        regenerative: profile.regenerative_dentistry_experience,
      },
      training: { regum_vet: profile.regum_training_status, microfoam: profile.microfoam_training_status },
      preferred_answer_depth: profile.preferred_answer_depth,
    },
    clinic: clinic ? { name: clinic.name, country: clinic.country, distributor: clinic.distributor } : null,
    permissions: clinicUser
      ? "Clinic member: may read/write this clinic's cases, inventory and orders."
      : "No clinic account: case, inventory and order tools are unavailable; knowledge and escalation only.",
    adoption: { state: adoption.state, guidance: ADOPTION_HINTS[adoption.state] },
    follow_ups: followUps,
    memories: memories.map((m) => ({ type: m.memory_type, fact: m.content })),
    active_case: activeCase,
    inventory,
    products: products.map((p) => ({ name: p.name, sku: p.sku, units_per_package: p.units_per_package })),
    approved_knowledge: knowledge.length ? knowledge : "No pre-retrieved approved passages for this message. Use search_knowledge if the question needs product information.",
    available_tools: toolDeclarations().map((t) => t.name),
  };

  return {
    contextBlock: `<runtime_context>\n${JSON.stringify(context, null, 1)}\n</runtime_context>`,
    history: historyRows,
  };
}
