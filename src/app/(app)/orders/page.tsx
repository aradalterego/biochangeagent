import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { getOrderHistory } from "@/server/domain/orders";
import { estimateInventory } from "@/server/domain/inventory";
import { listProducts } from "@/server/domain/products";
import { getClinic } from "@/server/domain/profile";
import { confirmOrderAction, prepareOrderAction, updateOrderStatusAction } from "@/app/actions/commerce";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";

const NEXT: Record<string, string[]> = {
  draft: ["cancelled"],
  submitted: ["confirmed", "shipped", "received", "cancelled"],
  confirmed: ["shipped", "received", "cancelled"],
  shipped: ["received"],
};

export default async function OrdersPage() {
  const user = await requireRole(["veterinarian", "clinic_admin"]);
  const actor = actorFromSession(user);
  const [orders, forecasts, products, clinic] = await Promise.all([getOrderHistory(actor, 100), estimateInventory(actor), listProducts(), getClinic(actor)]);
  const drafts = orders.filter((o) => o.status === "draft");
  const suggestion = forecasts.find((f) => f.likelyLow);

  return (
    <Page wide>
      <PageHeader title="Orders" subtitle="Prepare and record orders. Nothing is purchased automatically — place the order with your distributor, then record it here." />

      {drafts.length > 0 && (
        <Section title="Draft orders waiting for confirmation">
          <ul className="space-y-3">
            {drafts.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand/30 bg-brand-soft/50 px-4 py-3 text-sm">
                <span><span className="font-medium">{o.quantity} package(s) of {o.product_name}</span> <span className="text-muted">· SKU {o.sku} · {o.distributor ?? "no distributor"} · prepared {fmtDate(o.created_at)}</span></span>
                <div className="flex gap-2">
                  <ActionForm action={confirmOrderAction.bind(null, o.id)} submitLabel="Confirm & record order" />
                  <ActionForm action={updateOrderStatusAction.bind(null, o.id)} submitLabel="Discard" submitClassName="btn-secondary"><input type="hidden" name="status" value="cancelled" /></ActionForm>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Prepare an order">
          {suggestion && (
            <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              Based on recorded usage, {suggestion.product} is likely down to about {suggestion.estimatedStock} unit(s).
              {suggestion.typicalOrderPackages ? ` Your usual order is ${suggestion.typicalOrderPackages} package(s).` : ""}
            </p>
          )}
          <ActionForm action={prepareOrderAction} submitLabel="Prepare draft">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="label">Product</label><select name="product" className="input">{products.map((p) => <option key={p.id} value={p.sku}>{p.name} ({p.units_per_package}/package)</option>)}</select></div>
              <div><label className="label">Packages</label><input name="quantity" type="number" min={1} defaultValue={suggestion?.typicalOrderPackages ?? 1} className="input" /></div>
              <div className="sm:col-span-2"><label className="label">Notes</label><input name="notes" className="input" /></div>
            </div>
          </ActionForm>
        </Section>
        <Section title="Distributor">
          <p className="text-sm font-medium">{clinic?.distributor_name ?? "No distributor set"}</p>
          {clinic?.ordering_notes && <p className="mt-1 text-sm text-muted">{clinic.ordering_notes}</p>}
          {clinic?.ordering_email && <p className="mt-1 text-sm">Email: {clinic.ordering_email}</p>}
          {clinic?.ordering_url && <p className="mt-1 text-sm"><a href={clinic.ordering_url} className="text-brand" target="_blank" rel="noreferrer">Ordering portal</a></p>}
        </Section>
      </div>

      <Section title="Order history">
        {orders.filter((o) => o.status !== "draft").length ? (
          <table className="table">
            <thead><tr><th>Date</th><th>Product</th><th>Packages</th><th>Status</th><th>Distributor</th><th>By</th><th>Update</th></tr></thead>
            <tbody>
              {orders.filter((o) => o.status !== "draft").map((o) => (
                <tr key={o.id}>
                  <td>{fmtDate(o.order_date ?? o.created_at)}</td>
                  <td>{o.product_name}</td>
                  <td>{o.quantity} <span className="text-xs text-muted">({o.quantity * o.units_per_package} units)</span></td>
                  <td><Badge tone={statusTone(o.status)}>{o.status}</Badge></td>
                  <td>{o.distributor ?? "—"}</td>
                  <td>{o.created_by_name ?? "—"}</td>
                  <td>
                    {NEXT[o.status]?.length ? (
                      <ActionForm action={updateOrderStatusAction.bind(null, o.id)} submitLabel="Update" submitClassName="btn-secondary" className="flex items-center gap-2">
                        <select name="status" className="input w-32">{NEXT[o.status].map((s) => <option key={s} value={s}>{s}</option>)}</select>
                      </ActionForm>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No recorded orders yet.</Empty>
        )}
      </Section>
    </Page>
  );
}
