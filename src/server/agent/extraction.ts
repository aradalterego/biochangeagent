import "server-only";
import { sql } from "@/lib/db";
import { env, isOpenAIConfigured } from "@/lib/env";
import type { Actor } from "@/lib/authz";
import { openai } from "@/server/ai/openai";
import { MEMORY_TYPES, saveMemory, type MemoryType } from "@/server/domain/memory";
import { logKnowledgeGap } from "@/server/domain/gaps";
import { arr, enumOf, num, obj, str, nullable } from "./schema";
import type { TurnState } from "./tools";

export const INTENTS = [
  "general_question", "product_information", "product_comparison", "clinical_case", "product_selection", "procedure_guidance",
  "troubleshooting", "scientific_evidence", "case_followup", "training", "inventory", "order", "reorder", "support", "account", "feedback",
] as const;

const FACT_TYPES = ["user_fact", "case_fact", "product_usage", "inventory_statement", "order_intent", "follow_up_request", "training_completion", "unanswered_question"] as const;

const SCHEMA = obj({
  classification: obj({
    primary_intent: enumOf(INTENTS),
    secondary_intent: nullable(enumOf(INTENTS)),
    clinical_context: enumOf(["none", "general", "specific_case"]),
    commercial_context: enumOf(["none", "inventory", "order", "pricing"]),
    urgency: enumOf(["routine", "soon", "in_procedure"]),
    risk_level: enumOf(["low", "medium", "high"]),
    answer_level: enumOf(["not_clinical", "known_approved", "clinical_interpretation", "unknown"]),
  }),
  facts: arr(obj({
    type: enumOf(FACT_TYPES),
    memory_type: nullable(enumOf(MEMORY_TYPES)),
    statement: str("One self-contained sentence, third person."),
    confidence: num("0–1"),
  })),
});

const PROMPT = `You analyse one exchange between a veterinarian and the BioChange Vet Companion (an AI product/clinical companion).
Return:
1. classification of the USER message (intent, context, urgency, risk) and the level of the ASSISTANT answer:
   known_approved (answered from cited approved sources), clinical_interpretation (approved info + vet judgement), unknown (assistant said it lacks approved information), not_clinical.
2. facts: durable, explicitly stated information worth keeping. Only include what the USER explicitly said (never infer).
   - user_fact: preferences, experience, workflow, usual order size (set memory_type).
   - training_completion: the user says they completed a training.
   - case_fact / product_usage / inventory_statement / order_intent / follow_up_request: state them, they will be reviewed, not applied silently.
   - unanswered_question: only if the assistant could not answer a professional question.
Do not include clinical case details as user_fact. Return an empty list when nothing qualifies.`;

/**
 * Optional structured extraction after a response. It never performs consequential
 * mutations: those happen only through explicit tool calls during the turn. Low-risk,
 * explicitly stated preferences may be stored as memories.
 */
export async function runExtraction(args: {
  actor: Actor;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
  state: TurnState;
}) {
  if (!isOpenAIConfigured()) return;
  const res = await openai().responses.create({
    model: env().OPENAI_EXTRACTION_MODEL,
    instructions: PROMPT,
    input: [{ role: "user", content: `USER:\n${args.userText}\n\nASSISTANT:\n${args.assistantText}` }],
    text: { format: { type: "json_schema", name: "turn_analysis", schema: SCHEMA, strict: true } },
    store: false,
  });
  const parsed = JSON.parse(res.output_text) as {
    classification: Record<string, string | null>;
    facts: { type: (typeof FACT_TYPES)[number]; memory_type: MemoryType | null; statement: string; confidence: number }[];
  };
  await applyExtraction(args, parsed);
}

export async function applyExtraction(
  args: { actor: Actor; conversationId: string; userMessageId: string; assistantMessageId: string; userText: string; state: TurnState },
  parsed: { classification: Record<string, string | null>; facts: { type: (typeof FACT_TYPES)[number]; memory_type: MemoryType | null; statement: string; confidence: number }[] },
) {
  await sql`UPDATE messages SET metadata = metadata || ${sql.json({ classification: parsed.classification } as never)} WHERE id = ${args.assistantMessageId}`;

  for (const f of parsed.facts.slice(0, 10)) {
    let status: "pending" | "applied" = "pending";
    if (f.type === "user_fact" && f.memory_type && f.confidence >= 0.85) {
      await saveMemory(args.actor, { memoryType: f.memory_type, content: f.statement, confidence: f.confidence, source: `extraction:${args.userMessageId}` }, { tool: "extraction", sourceMessageId: args.userMessageId });
      status = "applied";
    } else if (f.type === "unanswered_question" && !args.state.gapLogged) {
      await logKnowledgeGap({ question: args.userText, sourcesSearched: args.state.knowledgeSearches, reason: f.statement, userId: args.actor.userId, conversationId: args.conversationId });
      args.state.gapLogged = true;
      status = "applied";
    }
    await sql`INSERT INTO extracted_facts (conversation_id, source_message_id, user_id, fact_type, value, confidence, status)
              VALUES (${args.conversationId}, ${args.userMessageId}, ${args.actor.userId}, ${f.type},
                      ${sql.json({ statement: f.statement, memory_type: f.memory_type } as never)}, ${Math.min(1, Math.max(0, f.confidence))}, ${status})`;
  }

  if (parsed.classification.answer_level === "unknown" && !args.state.gapLogged) {
    await logKnowledgeGap({ question: args.userText, sourcesSearched: args.state.knowledgeSearches, reason: "Assistant answered at UNKNOWN level", userId: args.actor.userId, conversationId: args.conversationId });
  }
}
