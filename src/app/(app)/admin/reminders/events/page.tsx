import { requireRole } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { logEventAction } from "@/app/actions/engagement";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { TRIGGER_EVENTS, TRIGGER_LABELS, listVetEvents } from "@/server/domain/engagement";

/**
 * Trigger events. Most are recorded automatically (registration, recorded orders, treated cases,
 * usage questions to the agent); a purchase made outside the app is logged here by hand.
 */
export default async function EventsPage() {
  await requireRole(["biochange_admin"]);
  const [events, vets, products] = await Promise.all([
    listVetEvents(150),
    sql<{ id: string; name: string; email: string }[]>`SELECT id, name, email FROM users WHERE role IN ('veterinarian', 'clinic_admin') ORDER BY name`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM products WHERE active ORDER BY name`,
  ]);
  return (
    <Page wide>
      <PageHeader title="Trigger events" subtitle="What veterinarians did. Reminder rules send their emails a set time after these events." />
      <div className="grid gap-5 lg:grid-cols-3">
        <Section title="Log an event">
          <ActionForm action={logEventAction} submitLabel="Record event" resetOnSuccess>
            <div className="space-y-3">
              <div><label className="label">Veterinarian</label><select name="user_id" required className="input" defaultValue=""><option value="" disabled>Choose…</option>{vets.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.email})</option>)}</select></div>
              <div><label className="label">Event</label><select name="event_type" className="input" defaultValue="purchase">{TRIGGER_EVENTS.map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}</select></div>
              <div><label className="label">Product</label><select name="product_id" className="input" defaultValue=""><option value="">—</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
              <div><label className="label">Date</label><input type="date" name="occurred_at" className="input" /></div>
              <div><label className="label">Notes</label><input name="notes" className="input" placeholder="e.g. order via distributor" /></div>
            </div>
          </ActionForm>
          <p className="mt-3 text-xs text-muted">A purchase marks the veterinarian as a customer. Recorded automatically: registration, orders confirmed in the app, cases treated with a product, and questions to the AI agent about using a product (one per conversation).</p>
        </Section>
        <div className="lg:col-span-2">
          <Section title="Recent events">
            {events.length ? (
              <table className="table">
                <thead><tr><th>Date</th><th>Veterinarian</th><th>Event</th><th>Product</th><th>Source</th></tr></thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td>{fmtDate(e.occurred_at)}</td>
                      <td>{e.vet}</td>
                      <td>{TRIGGER_LABELS[e.event_type]}{e.notes && <div className="text-xs text-muted">{e.notes}</div>}</td>
                      <td>{e.product ?? "—"}</td>
                      <td><Badge>{e.source}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-sm text-muted">No events yet.</p>}
          </Section>
        </div>
      </div>
    </Page>
  );
}
