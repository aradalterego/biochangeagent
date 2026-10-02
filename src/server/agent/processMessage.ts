import "server-only";
import { sql } from "@/lib/db";
import { ValidationError, type Actor } from "@/lib/authz";
import { isOpenAIConfigured } from "@/lib/env";
import { openai } from "@/server/ai/openai";
import { buildContext } from "./context";
import { runAgent, type LLMClient } from "./loop";
import { isUuid } from "@/server/domain/cases";
import { newTurnState, type Citation, type PendingAction } from "./tools";

export type Channel = "web" | "whatsapp" | "messenger" | "apple_messages" | "rcs";

export interface ProcessMessageInput {
  /** Identity resolved and verified by the channel adapter (web session, future channel identity). */
  actor: Actor;
  channel: Channel;
  content: string;
  conversationId?: string | null;
  /** Optional case to attach this conversation to (e.g. "Ask about this case" from a case page). */
  caseId?: string | null;
}

export interface AssistantMessage {
  id: string;
  conversationId: string;
  content: string;
  sources: Citation[];
  pendingActions: PendingAction[];
  activeCaseId: string | null;
  error: boolean;
  createdAt: Date;
}

const MAX_MESSAGE_CHARS = 8000;

export const FALLBACK_NOT_CONFIGURED =
  "The AI service isn't configured on this server yet, so I can't answer right now. Your message has been saved. " +
  "(Administrator: set OPENAI_API_KEY.)";

export const FALLBACK_ERROR =
  "Sorry — I couldn't complete that request because of a technical problem, so I haven't given an answer. " +
  "Nothing was changed unless it is confirmed above. Please try again, or ask BioChange Medical Support if it is urgent.";

/**
 * Channel-independent entry point: process_message(user_identity, channel, content).
 * The web chat calls this today; WhatsApp / Messenger / RCS adapters can call the same
 * function later without any change to the agent.
 */
export async function processMessage(input: ProcessMessageInput, deps: { client?: LLMClient; runExtraction?: (fn: () => Promise<void>) => void } = {}): Promise<AssistantMessage> {
  const content = input.content?.trim();
  if (!content) throw new ValidationError("Message is empty.");
  if (content.length > MAX_MESSAGE_CHARS) throw new ValidationError(`Message is too long (max ${MAX_MESSAGE_CHARS} characters).`);
  const { actor } = input;

  // 1. Conversation (owned by this user) + persist the user message first.
  const conversation = await getOrCreateConversation(actor, input.channel, input.conversationId, content);
  if (input.caseId) {
    const { getCaseRow, linkConversation } = await import("@/server/domain/cases");
    const c = await getCaseRow(actor, input.caseId);
    await sql`UPDATE conversations SET active_case_id = ${c.id} WHERE id = ${conversation.id}`;
    await linkConversation(c.id, conversation.id);
    conversation.active_case_id = c.id;
  }
  const [userMsg] = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, content, metadata) VALUES (${conversation.id}, 'user', ${content}, ${sql.json({ channel: input.channel })})
    RETURNING id`;

  const state = newTurnState({ actor, conversationId: conversation.id, userMessageId: userMsg.id, userText: content, activeCaseId: conversation.active_case_id });

  // 2. Context → 3. agent loop with tools.
  let text: string;
  let error = false;
  let model: string | null = null;
  try {
    if (!deps.client && !isOpenAIConfigured()) {
      text = FALLBACK_NOT_CONFIGURED;
      error = true;
    } else {
      const ctx = await buildContext(state);
      const result = await runAgent(deps.client ?? openai(), state, ctx);
      text = result.text;
      model = result.model;
    }
  } catch (err) {
    console.error("[agent] turn failed", err);
    text = FALLBACK_ERROR;
    error = true;
  }

  // Only sources the answer actually cites are shown under it.
  const cited = error ? [] : [...state.citations.values()].filter((c) => new RegExp(`\\[${c.label}\\]`).test(text));
  const pendingActions = error ? [] : state.pendingActions;

  // 4. Persist the assistant message with its metadata.
  const [assistant] = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO messages (conversation_id, role, content, metadata)
    VALUES (${conversation.id}, 'assistant', ${text}, ${sql.json({
      sources: cited,
      retrieved: [...state.citations.values()].map((c) => ({ label: c.label, sourceId: c.sourceId, title: c.title })),
      pendingActions,
      tools: state.toolLog,
      knowledgeSearches: state.knowledgeSearches,
      escalationId: state.escalationId,
      error,
      model,
      channel: input.channel,
    } as never)})
    RETURNING id, created_at`;
  await sql`UPDATE conversations SET last_message_at = now(), active_case_id = ${state.activeCaseId} WHERE id = ${conversation.id}`;

  // 5. Post-response extraction runs after the reply (never blocks or changes the answer).
  if (!error) {
    const job = async () => {
      const { runExtraction } = await import("./extraction");
      await runExtraction({ actor, conversationId: conversation.id, userMessageId: userMsg.id, assistantMessageId: assistant.id, userText: content, assistantText: text, state });
    };
    if (deps.runExtraction) deps.runExtraction(job);
    else void job().catch((e) => console.error("[agent] extraction failed", e));
  }

  return {
    id: assistant.id,
    conversationId: conversation.id,
    content: text,
    sources: cited,
    pendingActions,
    activeCaseId: state.activeCaseId,
    error,
    createdAt: assistant.created_at,
  };
}

async function getOrCreateConversation(actor: Actor, channel: Channel, id: string | null | undefined, firstMessage: string) {
  if (id) {
    if (!isUuid(id)) throw new ValidationError("Conversation not found.");
    const [c] = await sql<{ id: string; active_case_id: string | null }[]>`
      SELECT id, active_case_id FROM conversations WHERE id = ${id} AND user_id = ${actor.userId}`;
    if (!c) throw new ValidationError("Conversation not found.");
    return c;
  }
  const title = firstMessage.replace(/\s+/g, " ").slice(0, 80);
  const [c] = await sql<{ id: string; active_case_id: string | null }[]>`
    INSERT INTO conversations (user_id, clinic_id, channel, title) VALUES (${actor.userId}, ${actor.clinicId}, ${channel}, ${title})
    RETURNING id, active_case_id`;
  return c;
}
