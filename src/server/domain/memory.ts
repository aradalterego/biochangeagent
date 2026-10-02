import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { NotFoundError, ValidationError, type Actor } from "@/lib/authz";

export const MEMORY_TYPES = ["preference", "training", "product_usage", "ordering", "experience", "workflow", "other"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
  id: string;
  memory_type: MemoryType;
  content: string;
  structured_value: unknown;
  confidence: number;
  source: string;
  updated_at: Date;
}

export async function getMemories(userId: string, limit = 20): Promise<Memory[]> {
  return sql<Memory[]>`
    SELECT id, memory_type, content, structured_value, confidence, source, updated_at FROM memories
    WHERE user_id = ${userId} AND active ORDER BY confidence DESC, updated_at DESC LIMIT ${limit}`;
}

/**
 * Stores a durable fact about the user or clinic. Near-duplicates (same type, same
 * normalised text) refresh the existing memory instead of creating another row.
 */
export async function saveMemory(
  actor: Actor,
  input: { memoryType: MemoryType; content: string; structuredValue?: unknown; confidence?: number; source: string },
  ctx: OpContext = {},
): Promise<{ id: string; updated: boolean }> {
  if (!MEMORY_TYPES.includes(input.memoryType)) throw new ValidationError("Unknown memory type");
  const content = input.content?.trim();
  if (!content || content.length > 500) throw new ValidationError("Memory must be 1–500 characters.");
  const confidence = Math.min(1, Math.max(0, input.confidence ?? 0.8));
  const norm = content.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM memories WHERE user_id = ${actor.userId} AND active AND memory_type = ${input.memoryType}
      AND trim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g')) = ${norm}`;
  return sql.begin(async (tx) => {
    let id: string;
    if (existing) {
      await tx`UPDATE memories SET confidence = greatest(confidence, ${confidence}), updated_at = now() WHERE id = ${existing.id}`;
      id = existing.id;
    } else {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO memories (user_id, clinic_id, memory_type, content, structured_value, confidence, source)
        VALUES (${actor.userId}, ${actor.clinicId}, ${input.memoryType}, ${content}, ${input.structuredValue == null ? null : tx.json(input.structuredValue as never)},
                ${confidence}, ${input.source}) RETURNING id`;
      id = row.id;
    }
    await audit(actor, { action: existing ? "memory.refresh" : "memory.create", entityType: "memory", entityId: id, tool: ctx.tool,
      sourceMessageId: ctx.sourceMessageId, inputSummary: content }, tx);
    return { id, updated: Boolean(existing) };
  });
}

export async function forgetMemory(actor: Actor, id: string, ctx: OpContext = {}) {
  const [m] = await sql<{ user_id: string }[]>`SELECT user_id FROM memories WHERE id = ${id}`;
  if (!m || m.user_id !== actor.userId) throw new NotFoundError("Memory not found");
  await sql`UPDATE memories SET active = false, updated_at = now() WHERE id = ${id}`;
  await audit(actor, { action: "memory.forget", entityType: "memory", entityId: id, tool: ctx.tool ?? "ui" });
}
