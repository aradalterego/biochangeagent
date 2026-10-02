import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { assertClinicWrite, NotFoundError, requireClinic, ValidationError, type Actor } from "@/lib/authz";
import { resolveProduct } from "./products";
import { recomputeAdoption } from "./adoption";
import { isUuid } from "./cases";

export const ORDER_STATUSES = ["draft", "submitted", "confirmed", "shipped", "received", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderRow {
  id: string;
  clinic_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  units_per_package: number;
  quantity: number;
  order_date: Date | null;
  status: OrderStatus;
  distributor: string | null;
  price: string | null;
  currency: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const ORDER_SELECT = sql`
  SELECT o.*, p.name AS product_name, p.sku, p.units_per_package, u.name AS created_by_name,
         coalesce(o.distributor, d.name) AS distributor
  FROM orders o JOIN products p ON p.id = o.product_id
  LEFT JOIN users u ON u.id = o.created_by
  LEFT JOIN distributors d ON d.id = o.distributor_id`;

export async function getOrderHistory(actor: Actor, limit = 50): Promise<OrderRow[]> {
  const clinicId = requireClinic(actor);
  return sql<OrderRow[]>`${ORDER_SELECT} WHERE o.clinic_id = ${clinicId} ORDER BY o.created_at DESC LIMIT ${Math.min(limit, 200)}`;
}

export async function getOrder(actor: Actor, id: string): Promise<OrderRow> {
  if (!isUuid(id)) throw new NotFoundError("Order not found");
  const clinicId = requireClinic(actor);
  const [o] = await sql<OrderRow[]>`${ORDER_SELECT} WHERE o.id = ${id} AND o.clinic_id = ${clinicId}`;
  if (!o) throw new NotFoundError("Order not found");
  return o;
}

/**
 * Prepares a DRAFT order. Nothing is purchased or submitted: a draft only becomes a recorded
 * order when the veterinarian presses "Confirm & record" in the UI (confirmOrder).
 */
export async function prepareOrder(
  actor: Actor,
  input: { productRef: string; quantity: number; notes?: string | null },
  ctx: OpContext = {},
): Promise<OrderRow> {
  const clinicId = requireClinic(actor);
  assertClinicWrite(actor, clinicId);
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 500) throw new ValidationError("Order quantity (packages) must be between 1 and 500.");
  const product = await resolveProduct(input.productRef);
  const [clinic] = await sql<{ distributor_id: string | null }[]>`SELECT distributor_id FROM clinics WHERE id = ${clinicId}`;
  const id = await sql.begin(async (tx) => {
    const [o] = await tx<{ id: string }[]>`
      INSERT INTO orders (clinic_id, product_id, quantity, status, distributor_id, created_by, notes)
      VALUES (${clinicId}, ${product.id}, ${input.quantity}, 'draft', ${clinic?.distributor_id ?? null}, ${actor.userId}, ${input.notes ?? null})
      RETURNING id`;
    await audit(actor, { action: "order.prepare", entityType: "order", entityId: o.id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: `draft: ${input.quantity} package(s) of ${product.name}` }, tx);
    return o.id;
  });
  return getOrder(actor, id);
}

/**
 * Explicit human confirmation step: records a draft as an order placed with the distributor.
 * Called only from an authenticated UI action, never directly by the model.
 */
export async function confirmOrder(actor: Actor, id: string, ctx: OpContext = {}): Promise<OrderRow> {
  const o = await getOrder(actor, id);
  assertClinicWrite(actor, o.clinic_id);
  if (o.status !== "draft") throw new ValidationError(`Order is already ${o.status}.`);
  await sql.begin(async (tx) => {
    await tx`UPDATE orders SET status = 'submitted', order_date = current_date, confirmed_by = ${actor.userId}, updated_at = now() WHERE id = ${id} AND status = 'draft'`;
    await audit(actor, { action: "order.confirm_record", entityType: "order", entityId: id, tool: ctx.tool ?? "ui", sourceMessageId: ctx.sourceMessageId,
      inputSummary: `${o.quantity} package(s) of ${o.product_name}` }, tx);
  });
  await recomputeAdoption(actor.userId);
  return getOrder(actor, id);
}

const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  draft: ["cancelled"], // draft → submitted only through confirmOrder
  submitted: ["confirmed", "shipped", "received", "cancelled"],
  confirmed: ["shipped", "received", "cancelled"],
  shipped: ["received"],
  received: [],
  cancelled: [],
};

/** Status updates after recording; "received" adds the delivered units to the estimated stock. */
export async function updateOrderStatus(actor: Actor, id: string, status: OrderStatus, ctx: OpContext = {}): Promise<OrderRow> {
  const o = await getOrder(actor, id);
  assertClinicWrite(actor, o.clinic_id);
  if (!ORDER_STATUSES.includes(status)) throw new ValidationError("Unknown order status.");
  if (!ALLOWED[o.status].includes(status)) {
    throw new ValidationError(
      o.status === "draft" && status === "submitted"
        ? "A draft order must be confirmed by the veterinarian with the Confirm button."
        : `Cannot change an order from ${o.status} to ${status}.`,
    );
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE orders SET status = ${status}, updated_at = now() WHERE id = ${id}`;
    if (status === "received") {
      const units = o.quantity * o.units_per_package;
      const [inv] = await tx<{ quantity_estimated: number }[]>`
        INSERT INTO inventory (clinic_id, product_id, quantity_estimated) VALUES (${o.clinic_id}, ${o.product_id}, ${units})
        ON CONFLICT (clinic_id, product_id) DO UPDATE
          SET quantity_estimated = coalesce(inventory.quantity_estimated, inventory.quantity_confirmed, 0) + ${units}, updated_at = now()
        RETURNING quantity_estimated`;
      await tx`INSERT INTO inventory_events (clinic_id, product_id, event_type, quantity, estimated_after, order_id, created_by)
               VALUES (${o.clinic_id}, ${o.product_id}, 'order_received', ${units}, ${inv.quantity_estimated}, ${id}, ${actor.userId})`;
    }
    await audit(actor, { action: "order.update_status", entityType: "order", entityId: id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: `${o.status} → ${status}` }, tx);
  });
  await recomputeAdoption(actor.userId);
  return getOrder(actor, id);
}
