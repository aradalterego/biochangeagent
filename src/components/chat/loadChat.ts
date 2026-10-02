import "server-only";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import type { ChatMessage } from "./types";

export async function loadConversation(user: SessionUser, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [conv] = await sql<{ id: string; title: string | null; active_case_id: string | null }[]>`
    SELECT id, title, active_case_id FROM conversations WHERE id = ${id} AND user_id = ${user.id}`;
  if (!conv) notFound();
  const rows = await sql<{ id: string; role: ChatMessage["role"]; content: string; metadata: Record<string, unknown>; created_at: Date }[]>`
    SELECT id, role, content, metadata, created_at FROM messages WHERE conversation_id = ${id} AND role IN ('user', 'assistant', 'system') ORDER BY created_at`;
  const messages: ChatMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    sources: (r.metadata.sources as ChatMessage["sources"]) ?? [],
    pendingActions: (r.metadata.pendingActions as ChatMessage["pendingActions"]) ?? [],
    error: Boolean(r.metadata.error),
    createdAt: r.created_at.toISOString(),
  }));
  const orderIds = messages.flatMap((m) => m.pendingActions.filter((a) => a.type === "confirm_order").map((a) => (a as { orderId: string }).orderId));
  const statuses = orderIds.length && user.clinicId
    ? await sql<{ id: string; status: string }[]>`SELECT id, status FROM orders WHERE id = ANY(${orderIds}::uuid[]) AND clinic_id = ${user.clinicId}`
    : [];
  return { conv, messages, orderStatuses: Object.fromEntries(statuses.map((s) => [s.id, s.status])) };
}
