import "server-only";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AuthorizationError, NotFoundError, ValidationError, type Actor } from "@/lib/authz";
import { AUTHORITY_LEVELS, SOURCE_TYPES } from "@/server/knowledge/constants";
import { searchKnowledge, type KnowledgeHit } from "@/server/knowledge/retrieve";
import { getSource } from "@/server/knowledge/sources";
import { getApprovedClaims } from "@/server/knowledge/claims";
import { getUserProfile, updateUserProfile, getClinic, getClinicSummary } from "@/server/domain/profile";
import {
  CASE_STATUSES, addCaseNote, closeCase, completeFollowUp, createCase, getCase, isUuid, linkConversation, scheduleFollowUp,
  searchCases, updateCase, type CaseInput,
} from "@/server/domain/cases";
import { estimateInventory, getInventory, recordProductUsage, setInventoryConfirmed } from "@/server/domain/inventory";
import { ORDER_STATUSES, getOrder, getOrderHistory, prepareOrder, updateOrderStatus, type OrderStatus } from "@/server/domain/orders";
import { listEducation, recordTrainingActivity } from "@/server/domain/education";
import { ADOPTION_HINTS, ADOPTION_STATES, getAdoptionState, updateAdoptionState, type AdoptionState } from "@/server/domain/adoption";
import { createMedicalSupportRequest } from "@/server/domain/escalations";
import { logKnowledgeGap } from "@/server/domain/gaps";
import { MEMORY_TYPES, saveMemory, type MemoryType } from "@/server/domain/memory";
import { listProducts } from "@/server/domain/products";
import { arr, bool, enumOf, int, nullable, num, obj, str } from "./schema";

// ---------------------------------------------------------------------------
// Turn state shared by the tools during one agent turn
// ---------------------------------------------------------------------------

export interface Citation {
  label: string;
  sourceId: string;
  chunkId: string;
  title: string;
  sourceType: string;
  authorityLevel: number;
  section: string | null;
  page: number | null;
  version: string | null;
  sourceUrl: string | null;
  excerpt: string;
}

export type PendingAction =
  | { type: "confirm_order"; orderId: string; summary: string }
  | { type: "open_case"; caseId: string; summary: string };

export interface TurnState {
  actor: Actor;
  conversationId: string;
  userMessageId: string;
  userText: string;
  activeCaseId: string | null;
  citations: Map<string, Citation>;
  citationByChunk: Map<string, string>;
  pendingActions: PendingAction[];
  toolLog: { name: string; ok: boolean; summary: string }[];
  knowledgeSearches: { query: string; product: string | null; results: number }[];
  gapLogged: boolean;
  escalationId: string | null;
}

export function newTurnState(init: Pick<TurnState, "actor" | "conversationId" | "userMessageId" | "userText" | "activeCaseId">): TurnState {
  return {
    ...init,
    citations: new Map(),
    citationByChunk: new Map(),
    pendingActions: [],
    toolLog: [],
    knowledgeSearches: [],
    gapLogged: false,
    escalationId: null,
  };
}

/** Assigns stable [S#] labels to retrieved passages and returns the model-facing view. */
export function registerHits(state: TurnState, hits: KnowledgeHit[]) {
  return hits.map((h) => {
    let label = state.citationByChunk.get(h.chunkId);
    if (!label) {
      label = `S${state.citations.size + 1}`;
      state.citationByChunk.set(h.chunkId, label);
      state.citations.set(label, {
        label,
        sourceId: h.sourceId,
        chunkId: h.chunkId,
        title: h.sourceTitle,
        sourceType: h.sourceType,
        authorityLevel: h.authorityLevel,
        section: h.section,
        page: h.page,
        version: h.documentVersion,
        sourceUrl: h.sourceUrl,
        excerpt: h.content.slice(0, 400),
      });
    }
    return {
      label,
      source_title: h.sourceTitle,
      source_type: h.sourceType,
      authority_level: h.authorityLevel,
      authority: AUTHORITY_LEVELS[h.authorityLevel],
      product: h.product,
      version: h.documentVersion,
      publication_date: h.publicationDate,
      section: h.section,
      page: h.page,
      text: h.content,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  run: (args: Record<string, any>, state: TurnState) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const ctxOf = (state: TurnState, tool: string) => ({ tool, sourceMessageId: state.userMessageId });
const nstr = (d?: string) => nullable(str(d));
const nint = (d?: string) => nullable(int(d));
const nnum = (d?: string) => nullable(num(d));

const caseFields = {
  internal_patient_identifier: nstr("Clinic's own patient reference (no owner names)."),
  species: nstr("Defaults to dog."),
  breed: nstr(),
  age: nstr(),
  tooth: nstr("Triadan number, e.g. 204."),
  condition_summary: nstr(),
  pocket_depth_mm: nnum("Probing depth in mm."),
  defect_type: nstr("e.g. infrabony 3-wall, suprabony, extraction socket."),
  furcation: nstr("e.g. F2."),
  procedure_type: nstr("e.g. open flap periodontal surgery, closed root planing."),
  treatment_goal: nstr(),
  product: nstr("Product name, variant or SKU, e.g. 'ReGum Vet'."),
  product_variant: nstr(),
  treatment_date: nstr("YYYY-MM-DD"),
  status: nullable(enumOf(CASE_STATUSES)),
  baseline_notes: nstr(),
  follow_up_date: nstr("YYYY-MM-DD"),
  outcome_notes: nstr(),
};

function toCaseInput(a: Record<string, unknown>): CaseInput {
  const map: Record<string, keyof CaseInput> = {
    internal_patient_identifier: "internalPatientIdentifier", species: "species", breed: "breed", age: "age", tooth: "tooth",
    condition_summary: "conditionSummary", pocket_depth_mm: "pocketDepthMm", defect_type: "defectType", furcation: "furcation",
    procedure_type: "procedureType", treatment_goal: "treatmentGoal", product: "product", product_variant: "productVariant",
    treatment_date: "treatmentDate", status: "status", baseline_notes: "baselineNotes", follow_up_date: "followUpDate", outcome_notes: "outcomeNotes",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (map[k] && v !== null && v !== undefined) out[map[k]] = v;
  return out as CaseInput;
}

function requireCaseId(id: unknown, state: TurnState): string {
  const resolved = (typeof id === "string" && id) || state.activeCaseId;
  if (!resolved || !isUuid(resolved)) throw new ValidationError("Which case? No case id given and no active case in this conversation. Use search_cases.");
  return resolved;
}

export const TOOLS: ToolDef[] = [
  // ----- Knowledge -----
  {
    name: "search_knowledge",
    description: "Search APPROVED BioChange knowledge (IFU, regulatory, protocols, peer-reviewed evidence, training, case studies, distributor and commercial info). Returns labelled passages [S#] with source metadata. Returns an empty list if nothing approved matches — never fill the gap from general knowledge.",
    parameters: obj({
      query: str("Specific search query."),
      product: nullable(enumOf(["ReGum Vet", "MicroFoam"])),
      source_types: nullable(arr(enumOf(SOURCE_TYPES))),
      authority_threshold: nint("Only sources at this authority level or better (1=IFU/regulatory … 7=marketing)."),
    }),
    mutating: false,
    async run(a, state) {
      const [profile] = await sql<{ country: string | null }[]>`SELECT country FROM users WHERE id = ${state.actor.userId}`;
      const hits = await searchKnowledge({
        query: a.query,
        product: a.product,
        sourceTypes: a.source_types,
        authorityThreshold: a.authority_threshold,
        market: profile?.country ?? null,
        limit: 5,
      });
      state.knowledgeSearches.push({ query: a.query, product: a.product ?? null, results: hits.length });
      if (!hits.length && !state.gapLogged) {
        state.gapLogged = true;
        await logKnowledgeGap({ question: state.userText, product: a.product, sourcesSearched: [{ query: a.query }], reason: "No approved passage matched", userId: state.actor.userId, conversationId: state.conversationId });
      }
      return { passages: registerHits(state, hits), note: hits.length ? undefined : "No approved BioChange source matched this query." };
    },
  },
  {
    name: "get_source",
    description: "Get metadata of an approved knowledge source by id (title, type, authority, version, dates, study details).",
    parameters: obj({ source_id: str() }),
    mutating: false,
    async run(a, state) {
      if (!isUuid(a.source_id)) throw new NotFoundError("Source not found");
      const s = await getSource(state.actor, a.source_id);
      return {
        id: s.id, title: s.title, source_type: s.source_type, authority_level: s.authority_level, product: s.product, version: s.version,
        publication_date: s.publication_date, market: s.country_or_market, regulatory_status: s.regulatory_status, status: s.status,
        last_reviewed_at: s.last_reviewed_at, study: s.study,
      };
    },
  },
  {
    name: "get_approved_claims",
    description: "Approved product claims with allowed context and restricted wording. Prefer this wording when making product claims.",
    parameters: obj({ product: nullable(enumOf(["ReGum Vet", "MicroFoam"])), claim_type: nstr() }),
    mutating: false,
    async run(a) {
      return { claims: await getApprovedClaims({ product: a.product, claimType: a.claim_type }) };
    },
  },
  {
    name: "report_knowledge_gap",
    description: "Log that a professional question could not be answered from approved knowledge (UNKNOWN level). Always call this when you give the 'not enough approved information' answer.",
    parameters: obj({ question: str("The user's question, self-contained."), product: nstr(), reason: str() }),
    mutating: true,
    async run(a, state) {
      const id = await logKnowledgeGap({ question: a.question, product: a.product, sourcesSearched: state.knowledgeSearches, reason: a.reason, userId: state.actor.userId, conversationId: state.conversationId });
      state.gapLogged = true;
      return { ok: true, gap_id: id };
    },
  },
  // ----- Profile / clinic -----
  {
    name: "get_user_profile",
    description: "The current veterinarian's profile (experience, training status, answer-depth preference).",
    parameters: obj({}),
    mutating: false,
    run: async (_a, state) => getUserProfile(state.actor.userId),
  },
  {
    name: "update_user_profile",
    description: "Update the current user's profile ONLY with information they explicitly stated (e.g. 'I finished the ReGum training', 'keep answers short').",
    parameters: obj({
      professional_title: nstr(), specialty: nstr(), years_in_practice: nint(),
      dental_experience_level: nullable(enumOf(["none", "basic", "intermediate", "advanced", "specialist"])),
      regenerative_dentistry_experience: nullable(enumOf(["none", "some", "experienced"])),
      regum_training_status: nullable(enumOf(["not_started", "in_progress", "completed"])),
      microfoam_training_status: nullable(enumOf(["not_started", "in_progress", "completed"])),
      preferred_answer_depth: nullable(enumOf(["concise", "balanced", "detailed"])),
    }),
    mutating: true,
    async run(a, state) {
      const p = await updateUserProfile(state.actor, {
        professionalTitle: a.professional_title, specialty: a.specialty, yearsInPractice: a.years_in_practice,
        dentalExperienceLevel: a.dental_experience_level, regenerativeDentistryExperience: a.regenerative_dentistry_experience,
        regumTrainingStatus: a.regum_training_status, microfoamTrainingStatus: a.microfoam_training_status, preferredAnswerDepth: a.preferred_answer_depth,
      }, ctxOf(state, "update_user_profile"));
      return { ok: true, profile: p };
    },
  },
  {
    name: "get_clinic",
    description: "The user's clinic (country, timezone, distributor and ordering details).",
    parameters: obj({}),
    mutating: false,
    run: async (_a, state) => getClinic(state.actor),
  },
  {
    name: "get_clinic_summary",
    description: "Counts of active cases, due/overdue follow-ups, draft and open orders for the user's clinic.",
    parameters: obj({}),
    mutating: false,
    run: async (_a, state) => getClinicSummary(state.actor),
  },
  {
    name: "list_products",
    description: "Active BioChange products with variants, SKUs and units per package.",
    parameters: obj({}),
    mutating: false,
    run: async () => ({ products: (await listProducts()).map((p) => ({ name: p.name, family: p.product_family, variant: p.variant, sku: p.sku, units_per_package: p.units_per_package, form: p.form, sku_is_placeholder: p.is_placeholder_sku })) }),
  },
  // ----- Memory -----
  {
    name: "save_memory",
    description: "Remember a durable, useful fact the user explicitly stated (preference, training, usual order size, workflow, experience). Not for case details or trivia.",
    parameters: obj({ memory_type: enumOf(MEMORY_TYPES), content: str("One sentence, third person, e.g. 'Prefers concise step-by-step answers during procedures.'"), confidence: num("0–1") }),
    mutating: true,
    async run(a, state) {
      const r = await saveMemory(state.actor, { memoryType: a.memory_type as MemoryType, content: a.content, confidence: a.confidence, source: `conversation:${state.userMessageId}` }, ctxOf(state, "save_memory"));
      return { ok: true, ...r };
    },
  },
  // ----- Cases -----
  {
    name: "search_cases",
    description: "Search the clinic's cases by free text (tooth, patient reference, condition), status or tooth.",
    parameters: obj({ query: nstr(), status: nullable(enumOf(CASE_STATUSES)), tooth: nstr() }),
    mutating: false,
    async run(a, state) {
      const rows = await searchCases(state.actor, { query: a.query, status: a.status, tooth: a.tooth, limit: 10 });
      return { cases: rows.map(caseBrief) };
    },
  },
  {
    name: "get_case",
    description: "Full case details: baseline, measurements (baseline vs follow-up), notes, follow-ups, product usage.",
    parameters: obj({ case_id: nstr("Defaults to the active case.") }),
    mutating: false,
    async run(a, state) {
      const id = requireCaseId(a.case_id, state);
      const c = await getCase(state.actor, id);
      return { ...c, case: caseBrief(c.case), files: c.files.map((f) => ({ type: f.file_type, name: f.file_name, description: f.description })) };
    },
  },
  {
    name: "set_active_case",
    description: "Mark which existing case this conversation is about, so 'this case' resolves in later turns.",
    parameters: obj({ case_id: str() }),
    mutating: false,
    async run(a, state) {
      const c = await getCase(state.actor, requireCaseId(a.case_id, state));
      await sql`UPDATE conversations SET active_case_id = ${c.case.id} WHERE id = ${state.conversationId} AND user_id = ${state.actor.userId}`;
      await linkConversation(c.case.id, state.conversationId);
      state.activeCaseId = c.case.id;
      return { ok: true, active_case: caseBrief(c.case) };
    },
  },
  {
    name: "create_case",
    description: "Save a new case. POLICY: only when the veterinarian explicitly asked or agreed to save it. Becomes the active case.",
    parameters: obj({ ...caseFields, user_confirmed: bool("true only if the user explicitly asked/agreed to save this case.") }),
    mutating: true,
    async run(a, state) {
      if (a.user_confirmed !== true) throw new ValidationError("Case not saved: ask the veterinarian whether they want to save this case first.");
      const c = await createCase(state.actor, toCaseInput(a), { ...ctxOf(state, "create_case"), conversationId: state.conversationId });
      state.activeCaseId = c.id;
      state.pendingActions.push({ type: "open_case", caseId: c.id, summary: caseTitle(c) });
      return { ok: true, case: caseBrief(c) };
    },
  },
  {
    name: "update_case",
    description: "Update fields of an existing case with information the user provided. Only pass fields that change (others null).",
    parameters: obj({ case_id: nstr("Defaults to the active case."), ...caseFields }),
    mutating: true,
    async run(a, state) {
      const { case_id, ...rest } = a;
      const c = await updateCase(state.actor, requireCaseId(case_id, state), toCaseInput(rest), ctxOf(state, "update_case"));
      return { ok: true, case: caseBrief(c) };
    },
  },
  {
    name: "close_case",
    description: "Close a case (cancels remaining scheduled follow-ups).",
    parameters: obj({ case_id: nstr(), outcome_notes: nstr() }),
    mutating: true,
    async run(a, state) {
      const c = await closeCase(state.actor, requireCaseId(a.case_id, state), a.outcome_notes, ctxOf(state, "close_case"));
      return { ok: true, case: caseBrief(c) };
    },
  },
  {
    name: "add_case_note",
    description: "Add a clinical note to a case.",
    parameters: obj({ case_id: nstr(), note: str() }),
    mutating: true,
    async run(a, state) {
      const n = await addCaseNote(state.actor, requireCaseId(a.case_id, state), a.note, ctxOf(state, "add_case_note"));
      return { ok: true, note_id: n.id };
    },
  },
  {
    name: "schedule_case_followup",
    description: "Schedule a follow-up for a case. Use a date the veterinarian chose or agreed to; do not invent a clinically recommended interval.",
    parameters: obj({ case_id: nstr(), due_date: str("YYYY-MM-DD"), reason: nstr() }),
    mutating: true,
    async run(a, state) {
      const f = await scheduleFollowUp(state.actor, requireCaseId(a.case_id, state), a.due_date, a.reason, ctxOf(state, "schedule_case_followup"));
      return { ok: true, follow_up_id: f.id, due: f.due_at };
    },
  },
  {
    name: "complete_case_followup",
    description: "Record a follow-up result (kept separately from the baseline). If follow_up_id is null, the case's next scheduled follow-up is used.",
    parameters: obj({
      case_id: nstr(), follow_up_id: nstr(), pocket_depth_mm: nnum(), attachment_level_mm: nnum(), mobility: nstr(), furcation: nstr(),
      notes: nstr(), outcome: nstr("Short outcome summary in the vet's words."),
    }),
    mutating: true,
    async run(a, state) {
      let fid = a.follow_up_id as string | null;
      if (!fid) {
        const caseId = requireCaseId(a.case_id, state);
        await getCase(state.actor, caseId);
        const [f] = await sql<{ id: string }[]>`SELECT id FROM follow_ups WHERE case_id = ${caseId} AND status = 'scheduled' ORDER BY due_at LIMIT 1`;
        if (!f) {
          const created = await scheduleFollowUp(state.actor, caseId, new Date().toISOString().slice(0, 10), "Follow-up recorded", ctxOf(state, "complete_case_followup"));
          fid = created.id;
        } else fid = f.id;
      }
      const r = await completeFollowUp(state.actor, fid!, {
        pocketDepthMm: a.pocket_depth_mm, attachmentLevelMm: a.attachment_level_mm, mobility: a.mobility, furcation: a.furcation, notes: a.notes, outcome: a.outcome,
      }, ctxOf(state, "complete_case_followup"));
      return { ok: true, case: caseBrief(r.case), measurements: r.measurements };
    },
  },
  // ----- Inventory -----
  {
    name: "get_inventory",
    description: "Clinic inventory per product: CONFIRMED count (+date) vs ESTIMATED stock from recorded usage.",
    parameters: obj({ product: nstr() }),
    mutating: false,
    run: async (a, state) => ({ inventory: await getInventory(state.actor, a.product), reminder: "Estimated values are derived from recorded usage and are not certain." }),
  },
  {
    name: "set_inventory_confirmed",
    description: "Record a stock count the user explicitly stated (e.g. 'I have 6 ReGum on the shelf'). Resets the estimate.",
    parameters: obj({ product: str(), quantity: int("Units on hand.") }),
    mutating: true,
    async run(a, state) {
      return { ok: true, inventory: await setInventoryConfirmed(state.actor, a.product, a.quantity, {}, ctxOf(state, "set_inventory_confirmed")) };
    },
  },
  {
    name: "record_product_usage",
    description: "Record units used (ideally on a case). Lowers ESTIMATED stock. Resolve the case and product variant first.",
    parameters: obj({ product: str(), quantity: int(), case_id: nstr("Case the units were used on (defaults to none; pass the active case id when it applies).") }),
    mutating: true,
    async run(a, state) {
      const r = await recordProductUsage(state.actor, { productRef: a.product, quantity: a.quantity, caseId: a.case_id }, ctxOf(state, "record_product_usage"));
      return { ok: true, ...r, wording: "Report as 'estimated stock'." };
    },
  },
  {
    name: "estimate_inventory",
    description: "Reorder estimate per product from recorded usage, case volume and typical order size (weeks until likely stock-out). An estimate, never certain.",
    parameters: obj({ product: nstr() }),
    mutating: false,
    run: async (a, state) => ({ forecasts: await estimateInventory(state.actor, a.product) }),
  },
  // ----- Orders -----
  {
    name: "get_order_history",
    description: "Recent orders for the clinic (including drafts).",
    parameters: obj({}),
    mutating: false,
    run: async (_a, state) => ({ orders: (await getOrderHistory(state.actor, 15)).map(orderBrief) }),
  },
  {
    name: "prepare_order",
    description: "Create a DRAFT order (packages). Does NOT place or submit anything. The user confirms with a button.",
    parameters: obj({ product: str(), quantity_packages: int(), notes: nstr() }),
    mutating: true,
    async run(a, state) {
      const o = await prepareOrder(state.actor, { productRef: a.product, quantity: a.quantity_packages, notes: a.notes }, ctxOf(state, "prepare_order"));
      const summary = `${o.quantity} package(s) of ${o.product_name} (SKU ${o.sku}, ${o.units_per_package} unit(s)/package)${o.distributor ? ` via ${o.distributor}` : ""}`;
      state.pendingActions.push({ type: "confirm_order", orderId: o.id, summary });
      return { ok: true, status: "draft", order_id: o.id, summary, next_step: "The user must press 'Confirm & record order' on the card. Do not say it was placed." };
    },
  },
  {
    name: "confirm_order_record",
    description: "Present the confirmation card for an existing DRAFT order. It does not record the order — only the user's button press does.",
    parameters: obj({ order_id: str() }),
    mutating: false,
    async run(a, state) {
      const o = await getOrder(state.actor, a.order_id);
      if (o.status !== "draft") return { ok: false, error: `Order is ${o.status}, not a draft.` };
      state.pendingActions.push({ type: "confirm_order", orderId: o.id, summary: `${o.quantity} package(s) of ${o.product_name} (SKU ${o.sku})` });
      return { ok: true, status: "awaiting_user_confirmation" };
    },
  },
  {
    name: "update_order_status",
    description: "Update a recorded order's status (confirmed, shipped, received, cancelled). 'received' adds units to estimated stock. Drafts can only be cancelled here.",
    parameters: obj({ order_id: str(), status: enumOf(ORDER_STATUSES.filter((s) => s !== "draft" && s !== "submitted")) }),
    mutating: true,
    async run(a, state) {
      const o = await updateOrderStatus(state.actor, a.order_id, a.status as OrderStatus, ctxOf(state, "update_order_status"));
      return { ok: true, order: orderBrief(o) };
    },
  },
  // ----- Education -----
  {
    name: "search_training_material",
    description: "Find education resources (tutorials, webinars, studies, case studies, training courses), personalised by what the user already opened/completed.",
    parameters: obj({ query: nstr(), product: nullable(enumOf(["ReGum Vet", "MicroFoam"])) }),
    mutating: false,
    run: async (a, state) => ({ resources: await listEducation(state.actor, { query: a.query, product: a.product, limit: 8 }) }),
  },
  {
    name: "record_training_activity",
    description: "Record that the user opened or completed an education resource (only if they said so).",
    parameters: obj({ resource_id: str(), completed: bool() }),
    mutating: true,
    run: async (a, state) => ({ ok: true, ...(await recordTrainingActivity(state.actor, a.resource_id, a.completed, ctxOf(state, "record_training_activity"))) }),
  },
  // ----- Adoption -----
  {
    name: "get_adoption_state",
    description: "Current adoption stage of the user (interested → trained → ordered → first use → active → repeat user / dormant).",
    parameters: obj({}),
    mutating: false,
    async run(_a, state) {
      const s = await getAdoptionState(state.actor.userId);
      return { ...s, guidance: ADOPTION_HINTS[s.state] };
    },
  },
  {
    name: "update_adoption_state",
    description: "Adjust the adoption state when the user tells you something the data cannot show (e.g. they stopped using the product).",
    parameters: obj({ state: enumOf(ADOPTION_STATES), reason: str() }),
    mutating: true,
    run: async (a, state) => ({ ok: true, ...(await updateAdoptionState(state.actor, a.state as AdoptionState, a.reason, ctxOf(state, "update_adoption_state"))) }),
  },
  // ----- Escalation -----
  {
    name: "create_medical_support_request",
    description: "Escalate a question to BioChange Medical Support. Only after the user agrees. Include what you searched and a neutral summary.",
    parameters: obj({
      question: str("Self-contained question for Medical Support."),
      product: nstr(),
      case_id: nstr(),
      agent_summary: str("Context and what approved sources did/did not cover."),
      urgency: enumOf(["low", "normal", "high", "urgent"]),
    }),
    mutating: true,
    async run(a, state) {
      const sourcesChecked = [...state.citations.values()].map((c) => ({ sourceId: c.sourceId, title: c.title }));
      const r = await createMedicalSupportRequest(state.actor, {
        question: a.question, product: a.product, caseId: a.case_id && isUuid(a.case_id) ? a.case_id : null,
        sourcesChecked, agentSummary: a.agent_summary, urgency: a.urgency, conversationId: state.conversationId,
      }, ctxOf(state, "create_medical_support_request"));
      state.escalationId = r.id;
      return { ok: true, request_id: r.id, status: r.status };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Function tool declarations for the Responses API. */
export function toolDeclarations() {
  return TOOLS.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: true }));
}

/**
 * Executes one model-requested tool call. Authorisation is enforced inside the domain
 * services using the server-side actor; the model cannot widen its own permissions.
 */
export async function executeTool(name: string, rawArgs: string, state: TurnState): Promise<unknown> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return { ok: false, error: `Unknown tool ${name}` };
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: "Arguments were not valid JSON." };
  }
  try {
    const result = await tool.run(args, state);
    state.toolLog.push({ name, ok: true, summary: summarizeArgs(args) });
    return result;
  } catch (err) {
    const known = err instanceof AuthorizationError || err instanceof ValidationError || err instanceof NotFoundError;
    if (!known) console.error(`[agent] tool ${name} failed`, err);
    state.toolLog.push({ name, ok: false, summary: known ? (err as Error).message : "internal error" });
    if (tool.mutating) {
      await audit(state.actor, {
        action: `tool.${name}`, entityType: "tool_call", tool: name, sourceMessageId: state.userMessageId,
        inputSummary: `${summarizeArgs(args)} → ${known ? (err as Error).message : "internal error"}`,
        result: err instanceof AuthorizationError ? "denied" : "error",
      }).catch(() => {});
    }
    return {
      ok: false,
      error: err instanceof AuthorizationError ? "not_authorized" : err instanceof NotFoundError ? "not_found" : err instanceof ValidationError ? "invalid" : "internal_error",
      message: known ? (err as Error).message : "The action failed due to a system error. Tell the user it did not complete.",
    };
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ")
    .slice(0, 400);
}

function caseBrief(c: {
  id: string; status: string; tooth: string | null; species: string; internal_patient_identifier: string | null; condition_summary: string | null;
  pocket_depth_mm: string | null; defect_type: string | null; furcation: string | null; procedure_type: string | null; treatment_goal: string | null;
  product_name?: string | null; product_variant: string | null; treatment_date: Date | null; follow_up_date: Date | null; outcome_notes: string | null;
  baseline_notes: string | null; next_follow_up?: Date | null; updated_at: Date;
}) {
  return {
    id: c.id, status: c.status, patient_ref: c.internal_patient_identifier, species: c.species, tooth: c.tooth, condition: c.condition_summary,
    pocket_depth_mm: c.pocket_depth_mm, defect_type: c.defect_type, furcation: c.furcation, procedure: c.procedure_type, goal: c.treatment_goal,
    product: c.product_name, variant: c.product_variant, treatment_date: dateOnly(c.treatment_date), next_follow_up: dateOnly(c.next_follow_up ?? c.follow_up_date),
    baseline_notes: c.baseline_notes, outcome: c.outcome_notes, updated: dateOnly(c.updated_at),
  };
}

export function caseTitle(c: { tooth: string | null; internal_patient_identifier: string | null; product_name?: string | null; condition_summary: string | null }) {
  return [c.product_name, c.tooth && `tooth ${c.tooth}`, c.internal_patient_identifier, !c.tooth && c.condition_summary].filter(Boolean).join(" · ") || "Case";
}

function orderBrief(o: { id: string; product_name: string; sku: string; quantity: number; units_per_package: number; status: string; order_date: Date | null; distributor: string | null; created_at: Date }) {
  return { id: o.id, product: o.product_name, sku: o.sku, packages: o.quantity, units: o.quantity * o.units_per_package, status: o.status, order_date: dateOnly(o.order_date), distributor: o.distributor, created: dateOnly(o.created_at) };
}

function dateOnly(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}
