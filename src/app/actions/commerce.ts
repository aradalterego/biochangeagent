"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { num, runAction, str, type ActionState } from "@/lib/actions";
import { recordProductUsage, setInventoryConfirmed } from "@/server/domain/inventory";
import { confirmOrder, prepareOrder, updateOrderStatus, type OrderStatus } from "@/server/domain/orders";

export async function confirmInventoryAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    const line = await setInventoryConfirmed(actorFromSession(user), str(fd, "product") ?? "", num(fd, "quantity") ?? -1, { lot: str(fd, "lot"), expiry: str(fd, "expiry") }, { tool: "ui" });
    return `Confirmed ${line.quantityConfirmed} × ${line.product}.`;
  });
  revalidatePath("/inventory");
  return r;
}

export async function recordUsageAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    const res = await recordProductUsage(actorFromSession(user), { productRef: str(fd, "product") ?? "", quantity: num(fd, "quantity") ?? 1, note: str(fd, "note") }, { tool: "ui" });
    return `Recorded. Estimated stock: ${res.estimatedStock}.`;
  });
  revalidatePath("/inventory");
  return r;
}

export async function prepareOrderAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    const o = await prepareOrder(actorFromSession(user), { productRef: str(fd, "product") ?? "", quantity: num(fd, "quantity") ?? 0, notes: str(fd, "notes") }, { tool: "ui" });
    return `Draft created: ${o.quantity} package(s) of ${o.product_name}. Review and confirm below.`;
  });
  revalidatePath("/orders");
  return r;
}

export async function confirmOrderAction(orderId: string, _p: ActionState): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await confirmOrder(actorFromSession(user), orderId, { tool: "ui" });
    return "Order recorded.";
  });
  revalidatePath("/orders");
  return r;
}

export async function updateOrderStatusAction(orderId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await runAction(async () => {
    await updateOrderStatus(actorFromSession(user), orderId, str(fd, "status") as OrderStatus, { tool: "ui" });
    return "Updated.";
  });
  revalidatePath("/orders");
  revalidatePath("/inventory");
  return r;
}
