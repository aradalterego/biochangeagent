import { sql, type Tx } from "./db";
import type { Actor } from "./authz";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  tool?: string | null; // agent tool name, or 'ui' | 'admin' | 'system'
  inputSummary?: string | null;
  result?: "success" | "denied" | "error";
  sourceMessageId?: string | null;
}

/** Every meaningful mutation is written here, inside the same transaction when one is given. */
export async function audit(actor: Actor | null, entry: AuditEntry, tx: Tx = sql): Promise<void> {
  await tx`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, tool, input_summary, result, source_message_id)
    VALUES (${actor?.userId ?? null}, ${entry.action}, ${entry.entityType}, ${entry.entityId ?? null},
            ${entry.tool ?? "ui"}, ${truncate(entry.inputSummary)}, ${entry.result ?? "success"}, ${entry.sourceMessageId ?? null})`;
}

/** Context passed down to domain services so audit rows can link back to the triggering chat message. */
export interface OpContext {
  tool?: string;
  sourceMessageId?: string | null;
}

function truncate(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length > 1000 ? `${s.slice(0, 997)}...` : s;
}
