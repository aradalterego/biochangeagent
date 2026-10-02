import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { sql } from "@/lib/db";
import { estimateInventory, getInventory } from "@/server/domain/inventory";
import { listProducts } from "@/server/domain/products";
import { confirmInventoryAction, recordUsageAction } from "@/app/actions/commerce";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";

export default async function InventoryPage() {
  const user = await requireRole(["veterinarian", "clinic_admin"]);
  const actor = actorFromSession(user);
  const [lines, forecasts, products] = await Promise.all([getInventory(actor), estimateInventory(actor), listProducts()]);
  const fc = new Map(forecasts.map((f) => [f.productId, f]));
  const events = await sql<{ event_type: string; quantity: number; estimated_after: number | null; created_at: Date; product: string; user_name: string | null; case_id: string | null }[]>`
    SELECT e.event_type, e.quantity, e.estimated_after, e.created_at, p.name AS product, u.name AS user_name, e.case_id
    FROM inventory_events e JOIN products p ON p.id = e.product_id LEFT JOIN users u ON u.id = e.created_by
    WHERE e.clinic_id = ${user.clinicId} ORDER BY e.created_at DESC LIMIT 20`;

  return (
    <Page wide>
      <PageHeader title="Inventory" subtitle="Confirmed counts are what someone counted. Estimated stock is calculated from recorded usage and orders — please confirm it periodically." />
      {lines.length ? (
        <div className="card mb-6 overflow-x-auto">
          <table className="table">
            <thead><tr><th>Product</th><th>Confirmed</th><th>Last confirmed</th><th>Estimated stock</th><th>Used (30 / 90 d)</th><th>Outlook</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const f = fc.get(l.productId);
                return (
                  <tr key={l.productId}>
                    <td className="font-medium">{l.product}<div className="text-xs text-muted">SKU {l.sku}</div></td>
                    <td>{l.quantityConfirmed ?? "—"}</td>
                    <td>{fmtDate(l.lastConfirmedAt)}</td>
                    <td><span className={f?.likelyLow ? "font-semibold text-warn" : ""}>{l.quantityEstimated ?? "—"}</span> <span className="text-xs text-muted">(estimate)</span></td>
                    <td>{l.usedLast30Days} / {l.usedLast90Days}</td>
                    <td>
                      {f?.likelyLow ? <Badge tone="warn">May run low</Badge> : <Badge>OK</Badge>}
                      {f?.weeksUntilStockOut != null && <div className="text-xs text-muted">~{f.weeksUntilStockOut} weeks at recent usage</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mb-6"><Empty>No inventory recorded yet. Confirm a count below.</Empty></div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Confirm inventory count">
          <ActionForm action={confirmInventoryAction} submitLabel="Confirm count">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="label">Product</label><select name="product" className="input">{products.map((p) => <option key={p.id} value={p.sku}>{p.name}</option>)}</select></div>
              <div><label className="label">Units on hand</label><input name="quantity" type="number" min={0} required className="input" /></div>
              <div><label className="label">Lot (optional)</label><input name="lot" className="input" /></div>
              <div><label className="label">Expiry (optional)</label><input name="expiry" type="date" className="input" /></div>
            </div>
          </ActionForm>
        </Section>
        <Section title="Record usage (without a case)">
          <ActionForm action={recordUsageAction} submitLabel="Record usage" submitClassName="btn-secondary">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="label">Product</label><select name="product" className="input">{products.map((p) => <option key={p.id} value={p.sku}>{p.name}</option>)}</select></div>
              <div><label className="label">Units used</label><input name="quantity" type="number" min={1} defaultValue={1} className="input" /></div>
              <div className="sm:col-span-2"><label className="label">Note</label><input name="note" className="input" /></div>
            </div>
          </ActionForm>
          <p className="mt-2 text-xs text-muted">Prefer recording usage on the case so outcomes and stock stay linked.</p>
        </Section>
      </div>

      <Section title="Recent stock activity">
        {events.length ? (
          <table className="table">
            <thead><tr><th>When</th><th>Product</th><th>Event</th><th>Qty</th><th>Estimated after</th><th>By</th></tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td>{fmtDateTime(e.created_at, user.timezone)}</td>
                  <td>{e.product}</td>
                  <td>{e.event_type.replace(/_/g, " ")}{e.case_id && <a className="ml-1 text-xs text-brand" href={`/cases/${e.case_id}`}>case</a>}</td>
                  <td>{e.quantity}</td>
                  <td>{e.estimated_after ?? "—"}</td>
                  <td>{e.user_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted">No activity yet.</p>
        )}
      </Section>
    </Page>
  );
}
