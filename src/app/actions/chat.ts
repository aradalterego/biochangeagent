"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { runAction } from "@/lib/actions";
import { confirmOrder } from "@/server/domain/orders";
import { sql } from "@/lib/db";

/** The explicit human confirmation step for a draft order prepared in chat. */
export async function confirmOrderFromChat(orderId: string, conversationId: string | null) {
  const user = await requireUser();
  const res = await runAction(async () => {
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
