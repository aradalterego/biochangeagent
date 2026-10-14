"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { AuthorizationError, actorFromSession } from "@/lib/authz";
import { featureEnabled } from "@/lib/features";
import { closeCase } from "@/server/domain/cases";
import { runAction } from "@/lib/actions";
import { confirmOrder } from "@/server/domain/orders";
import { sql } from "@/lib/db";

/** The explicit human confirmation step for a draft order prepared in chat. */
export async function confirmOrderFromChat(orderId: string, conversationId: string | null) {
  const user = await requireUser();
  const res = await runAction(async () => {
    if (!featureEnabled("orders")) throw new AuthorizationError("Ordering is not available.");
    const o = await confirmOrder(actorFromSession(user), orderId, { tool: "ui:chat_confirm" });
    if (conversationId) {
      await sql`INSERT INTO messages (conversation_id, role, content, metadata)
                SELECT ${conversationId}, 'system', ${`Order recorded: ${o.quantity} package(s) of ${o.product_name} (status: submitted).`}, ${sql.json({ event: "order_confirmed", orderId } as never)}
                WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ${conversationId} AND user_id = ${user.id})`;
    }
    return `Order recorded: ${o.quantity} package(s) of ${o.product_name}.`;
  });
  revalidatePath("/orders");
  return res;
}

/** The explicit human confirmation for closing a case proposed in chat. */
export async function closeCaseFromChat(caseId: string, outcomeNotes: string | null, conversationId: string | null) {
  const user = await requireUser();
  const res = await runAction(async () => {
    const c = await closeCase(actorFromSession(user), caseId, outcomeNotes, { tool: "ui:chat_confirm" });
    if (conversationId) {
      await sql`INSERT INTO messages (conversation_id, role, content, metadata)
                SELECT ${conversationId}, 'system', 'Case closed by the veterinarian.', ${sql.json({ event: "case_closed", caseId: c.id } as never)}
                WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ${conversationId} AND user_id = ${user.id})`;
    }
    return "Case closed.";
  });
  revalidatePath(`/cases/${caseId}`);
  return res;
}
