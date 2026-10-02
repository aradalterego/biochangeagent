import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { assertClinicWrite, requireClinic, ValidationError, type Actor } from "@/lib/authz";
import { resolveProduct } from "./products";
import { getCaseRow } from "./cases";
import { recomputeAdoption } from "./adoption";

export interface InventoryLine {
  productId: string;
  product: string;
  productFamily: string;
  sku: string;
  unitsPerPackage: number;
  /** Last count a person confirmed. */
  quantityConfirmed: number | null;
  lastConfirmedAt: Date | null;
  /** Derived from the confirmed count, recorded usage and received orders. Never certain. */
  quantityEstimated: number | null;
  usedSinceConfirmed: number;
  usedLast30Days: number;
  usedLast90Days: number;
  lot: string | null;
  expiry: Date | null;
}

export async function getInventory(actor: Actor, productRef?: string | null): Promise<InventoryLine[]> {
  const clinicId = requireClinic(actor);
  const productId = productRef ? (await resolveProduct(productRef)).id : null;
  const rows = await sql<
    {
      product_id: string; name: string; product_family: string; sku: string; units_per_package: number;
      quantity_confirmed: number | null; last_confirmed_at: Date | null; quantity_estimated: number | null;
      used_since: number; used_30: number; used_90: number; lot: string | null; expiry: Date | null;
    }[]
  >`
    SELECT p.id AS product_id, p.name, p.product_family, p.sku, p.units_per_package,
      i.quantity_confirmed, i.last_confirmed_at, i.quantity_estimated, i.lot, i.expiry,
      coalesce((SELECT sum(e.quantity) FROM inventory_events e WHERE e.clinic_id = ${clinicId} AND e.product_id = p.id
                AND e.event_type = 'usage' AND (i.last_confirmed_at IS NULL OR e.created_at > i.last_confirmed_at)), 0)::int AS used_since,
      coalesce((SELECT sum(e.quantity) FROM inventory_events e WHERE e.clinic_id = ${clinicId} AND e.product_id = p.id
                AND e.event_type = 'usage' AND e.created_at > now() - interval '30 days'), 0)::int AS used_30,
      coalesce((SELECT sum(e.quantity) FROM inventory_events e WHERE e.clinic_id = ${clinicId} AND e.product_id = p.id
                AND e.event_type = 'usage' AND e.created_at > now() - interval '90 days'), 0)::int AS used_90
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id AND i.clinic_id = ${clinicId}
    WHERE p.active AND (${productId}::uuid IS NULL OR p.id = ${productId})
      AND (i.id IS NOT NULL OR ${productId}::uuid IS NOT NULL
           OR EXISTS (SELECT 1 FROM orders o WHERE o.clinic_id = ${clinicId} AND o.product_id = p.id))
    ORDER BY p.product_family, p.variant NULLS FIRST`;
  return rows.map((r) => ({
    productId: r.product_id,
    product: r.name,
    productFamily: r.product_family,
    sku: r.sku,
    unitsPerPackage: r.units_per_package,
    quantityConfirmed: r.quantity_confirmed,
    lastConfirmedAt: r.last_confirmed_at,
    quantityEstimated: r.quantity_estimated,
    usedSinceConfirmed: r.used_since,
    usedLast30Days: r.used_30,
    usedLast90Days: r.used_90,
    lot: r.lot,
    expiry: r.expiry,
  }));
}

/** A person counted the stock: this resets the estimate to the confirmed number. */
export async function setInventoryConfirmed(
  actor: Actor,
  productRef: string,
  quantity: number,
  extra: { lot?: string | null; expiry?: string | null } = {},
  ctx: OpContext = {},
) {
  const clinicId = requireClinic(actor);
  assertClinicWrite(actor, clinicId);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10_000) throw new ValidationError("Quantity must be a whole number ≥ 0.");
  const product = await resolveProduct(productRef);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO inventory (clinic_id, product_id, quantity_confirmed, last_confirmed_at, last_confirmed_by, quantity_estimated, lot, expiry)
      VALUES (${clinicId}, ${product.id}, ${quantity}, now(), ${actor.userId}, ${quantity}, ${extra.lot ?? null}, ${extra.expiry || null})
      ON CONFLICT (clinic_id, product_id) DO UPDATE SET quantity_confirmed = EXCLUDED.quantity_confirmed, last_confirmed_at = now(),
        last_confirmed_by = EXCLUDED.last_confirmed_by, quantity_estimated = EXCLUDED.quantity_confirmed,
        lot = coalesce(EXCLUDED.lot, inventory.lot), expiry = coalesce(EXCLUDED.expiry, inventory.expiry), updated_at = now()`;
    await tx`INSERT INTO inventory_events (clinic_id, product_id, event_type, quantity, estimated_after, created_by)
             VALUES (${clinicId}, ${product.id}, 'confirmed_count', ${quantity}, ${quantity}, ${actor.userId})`;
    await audit(actor, { action: "inventory.confirm", entityType: "inventory", entityId: product.id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: `${product.name}: confirmed ${quantity} units` }, tx);
  });
  return (await getInventory(actor, product.id))[0];
}

/** Records units consumed (optionally on a case) and lowers the ESTIMATED stock. */
export async function recordProductUsage(
  actor: Actor,
  input: { productRef: string; quantity: number; caseId?: string | null; note?: string | null },
  ctx: OpContext = {},
) {
  const clinicId = requireClinic(actor);
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100) throw new ValidationError("Usage quantity must be a whole number between 1 and 100.");
  const product = await resolveProduct(input.productRef);
  if (input.caseId) {
    const c = await getCaseRow(actor, input.caseId);
    assertClinicWrite(actor, c.clinic_id);
  }
  const estimatedAfter = await sql.begin(async (tx) => {
    const [inv] = await tx<{ quantity_estimated: number | null }[]>`
      INSERT INTO inventory (clinic_id, product_id, quantity_estimated)
      VALUES (${clinicId}, ${product.id}, ${-input.quantity})
      ON CONFLICT (clinic_id, product_id) DO UPDATE
        SET quantity_estimated = coalesce(inventory.quantity_estimated, inventory.quantity_confirmed, 0) - ${input.quantity}, updated_at = now()
      RETURNING quantity_estimated`;
    await tx`INSERT INTO inventory_events (clinic_id, product_id, event_type, quantity, estimated_after, case_id, note, created_by)
             VALUES (${clinicId}, ${product.id}, 'usage', ${input.quantity}, ${inv.quantity_estimated}, ${input.caseId ?? null}, ${input.note ?? null}, ${actor.userId})`;
    if (input.caseId) {
      await tx`UPDATE cases SET product_id = coalesce(product_id, ${product.id}), product_variant = coalesce(product_variant, ${product.variant}),
               treatment_date = coalesce(treatment_date, current_date),
               status = CASE WHEN status IN ('discussion', 'planned') THEN 'treated' ELSE status END, updated_at = now()
               WHERE id = ${input.caseId}`;
    }
    await audit(actor, { action: "inventory.record_usage", entityType: "inventory", entityId: product.id, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: `${input.quantity} × ${product.name}${input.caseId ? ` on case ${input.caseId}` : ""}` }, tx);
    return inv.quantity_estimated;
  });
  await recomputeAdoption(actor.userId);
  const line = (await getInventory(actor, product.id))[0];
  return { product: product.name, quantityUsed: input.quantity, estimatedStock: estimatedAfter, inventory: line };
}

export interface StockForecast {
  product: string;
  productId: string;
  sku: string;
  unitsPerPackage: number;
  quantityConfirmed: number | null;
  lastConfirmedAt: Date | null;
  estimatedStock: number | null;
  avgUnitsPerWeek: number | null;
  weeksUntilStockOut: number | null;
  likelyLow: boolean;
  typicalOrderPackages: number | null;
  lastOrder: { quantity: number; date: Date | null; status: string } | null;
  basis: string;
}

/**
 * Lightweight V1 reorder estimate from recorded usage, recent case volume and typical
 * order size. It is an estimate and is always labelled as such.
 */
export async function estimateInventory(actor: Actor, productRef?: string | null): Promise<StockForecast[]> {
  const clinicId = requireClinic(actor);
  const lines = await getInventory(actor, productRef);
  const out: StockForecast[] = [];
  for (const l of lines) {
    const [hist] = await sql<{ first_use: Date | null; total_90: number; cases_90: number }[]>`
      SELECT min(created_at) AS first_use,
             coalesce(sum(quantity) FILTER (WHERE created_at > now() - interval '90 days'), 0)::int AS total_90,
             count(DISTINCT case_id) FILTER (WHERE created_at > now() - interval '90 days')::int AS cases_90
      FROM inventory_events WHERE clinic_id = ${clinicId} AND product_id = ${l.productId} AND event_type = 'usage'`;
    const orders = await sql<{ quantity: number; order_date: Date | null; status: string }[]>`
      SELECT quantity, order_date, status FROM orders WHERE clinic_id = ${clinicId} AND product_id = ${l.productId}
        AND status NOT IN ('draft', 'cancelled') ORDER BY coalesce(order_date, created_at::date) DESC LIMIT 5`;
    const weeksObserved = hist.first_use ? Math.min(13, Math.max(1, (Date.now() - hist.first_use.getTime()) / (7 * 864e5))) : null;
    const avg = weeksObserved && hist.total_90 > 0 ? hist.total_90 / weeksObserved : null;
    const est = l.quantityEstimated ?? l.quantityConfirmed;
    const weeks = avg && est != null ? Math.max(0, est / avg) : null;
    const typical = orders.length ? mode(orders.map((o) => o.quantity)) : null;
    const likelyLow = est != null && (est <= Math.max(2, Math.ceil(l.unitsPerPackage / 2)) || (weeks != null && weeks < 3));
    out.push({
      product: l.product,
      productId: l.productId,
      sku: l.sku,
      unitsPerPackage: l.unitsPerPackage,
      quantityConfirmed: l.quantityConfirmed,
      lastConfirmedAt: l.lastConfirmedAt,
      estimatedStock: est,
      avgUnitsPerWeek: avg != null ? Math.round(avg * 10) / 10 : null,
      weeksUntilStockOut: weeks != null ? Math.round(weeks * 10) / 10 : null,
      likelyLow,
      typicalOrderPackages: typical,
      lastOrder: orders[0] ? { quantity: orders[0].quantity, date: orders[0].order_date, status: orders[0].status } : null,
      basis: `Recorded usage: ${hist.total_90} unit(s) across ${hist.cases_90} case(s) in the last 90 days; ` +
        (l.lastConfirmedAt ? `last confirmed count ${l.quantityConfirmed} on ${l.lastConfirmedAt.toISOString().slice(0, 10)}; ${l.usedSinceConfirmed} used since.` : "no confirmed count on record."),
    });
  }
  return out;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
