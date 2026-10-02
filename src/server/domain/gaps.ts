import "server-only";
import { sql } from "@/lib/db";
import { assertKnowledgeManager, type Actor } from "@/lib/authz";
import { normalizeQuestion } from "./escalations";

/** Logged whenever the agent cannot answer a professional question from approved knowledge. */
export async function logKnowledgeGap(input: {
  question: string;
  product?: string | null;
  sourcesSearched?: unknown[];
  reason: string;
  userId: string | null;
  conversationId?: string | null;
}): Promise<string> {
  const norm = normalizeQuestion(input.question);
  if (!norm) return "";
  return sql.begin(async (tx) => {
    const [g] = await tx<{ id: string }[]>`
      INSERT INTO knowledge_gaps (normalized_question, question, product, sources_searched, reason_unresolved)
      VALUES (${norm}, ${input.question.trim().slice(0, 1000)}, ${input.product ?? null}, ${tx.json((input.sourcesSearched ?? []) as never)}, ${input.reason})
      ON CONFLICT (normalized_question) DO UPDATE SET frequency = knowledge_gaps.frequency + 1, last_seen_at = now(),
        reason_unresolved = EXCLUDED.reason_unresolved, product = coalesce(knowledge_gaps.product, EXCLUDED.product),
        status = CASE WHEN knowledge_gaps.status = 'dismissed' THEN 'dismissed' ELSE 'open' END
      RETURNING id`;
    await tx`INSERT INTO knowledge_gap_occurrences (gap_id, user_id, conversation_id) VALUES (${g.id}, ${input.userId}, ${input.conversationId ?? null})`;
    return g.id;
  });
}

export async function listKnowledgeGaps(actor: Actor, status = "open") {
  assertKnowledgeManager(actor);
  return sql`
    SELECT g.*, (SELECT count(DISTINCT user_id)::int FROM knowledge_gap_occurrences o WHERE o.gap_id = g.id) AS user_count,
           s.title AS resolved_source_title
    FROM knowledge_gaps g LEFT JOIN knowledge_sources s ON s.id = g.resolved_source_id
    WHERE g.status = ${status}
    ORDER BY g.frequency DESC, g.last_seen_at DESC LIMIT 200`;
}

export async function resolveKnowledgeGap(actor: Actor, id: string, status: "resolved" | "dismissed", sourceId: string | null) {
  assertKnowledgeManager(actor);
  await sql`UPDATE knowledge_gaps SET status = ${status}, resolved_source_id = ${sourceId} WHERE id = ${id}`;
}
