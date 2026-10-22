import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { dashboardFilterOptions, listDashboardVets, vetFiltersFromParams } from "@/server/domain/dashboard";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

type SP = Record<string, string | string[] | undefined>;

export default async function DashboardVetsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const actor = actorFromSession(user);
  const sp = await searchParams;
  const f = vetFiltersFromParams(sp);
  const [vets, opts] = await Promise.all([listDashboardVets(actor, f), dashboardFilterOptions(actor)]);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) params.set(k, v);
  // Case links carry the same product / country / period so the numbers match.
  const caseQs = (vetId: string, extra = "") => {
    const p = new URLSearchParams({ vet: vetId });
    if (f.productId) p.set("product", f.productId);
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
    return `/dashboard/cases?${p}${extra}`;
  };
  params.set("type", "vets");
  return (
    <Page wide>
      <PageHeader
        title="Veterinarians"
        subtitle={`${vets.length} veterinarian(s)${f.productId || f.from || f.to ? " with activity for these filters" : ""}.`}
        actions={<a href={`/api/reports?${params}`} className="btn-primary">Download report (CSV)</a>}
      />
      <form className="card mb-5 grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-7">
        <input name="q" defaultValue={f.q ?? ""} placeholder="Search name, email, clinic…" className="input lg:col-span-2" />
        <select name="product" defaultValue={f.productId ?? ""} className="input"><option value="">All products</option>{opts.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select name="country" defaultValue={f.country ?? ""} className="input"><option value="">All countries</option>{opts.countries.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select name="customer" defaultValue={f.customer ?? ""} className="input"><option value="">Any customer status</option><option value="yes">Customers</option><option value="no">Non-customers</option></select>
        <div className="flex gap-2 lg:col-span-2">
          <input type="date" name="from" defaultValue={f.from ?? ""} className="input" aria-label="Activity from" title="Activity from" />
          <input type="date" name="to" defaultValue={f.to ?? ""} className="input" aria-label="Activity to" title="Activity to" />
        </div>
        <div className="flex gap-2">
          <button className="btn-primary">Filter</button>
          <Link href="/dashboard/vets" className="btn-secondary">Reset</Link>
        </div>
      </form>
      <Section title="All veterinarians">
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Name</th><th>Clinic</th><th>Customer</th><th>Cases</th><th>Open</th><th>Follow-up overdue</th><th>Follow-up missing</th><th>Feedback</th><th>Purchases</th><th>Last sign-in</th><th>Last active</th></tr></thead>
            <tbody>
              {vets.map((v) => (
                <tr key={v.id}>
                  <td>{v.title ? `${v.title} ` : ""}{v.name}{!v.active && <> <Badge tone="danger">inactive</Badge></>}<div className="text-xs text-muted">{v.email}</div></td>
                  <td>{v.clinic ?? "—"}<div className="text-xs text-muted">{v.country ?? ""}</div></td>
                  <td>{v.is_customer ? <Badge tone="ok">customer</Badge> : <span className="text-xs text-muted">no</span>}</td>
                  <td>{v.cases ? <Link className="text-brand hover:underline" href={caseQs(v.id)}>{v.cases}</Link> : 0}</td>
                  <td>{v.open_cases}</td>
                  <td>{v.overdue ? <Link className="text-danger hover:underline" href={caseQs(v.id, "&follow_up=overdue")}>{v.overdue}</Link> : 0}</td>
                  <td>{v.missing ? <Link className="text-danger hover:underline" href={caseQs(v.id, "&follow_up=missing")}>{v.missing}</Link> : 0}</td>
                  <td>{v.feedback}</td>
                  <td>{v.purchases}</td>
                  <td>{v.last_login_at ? fmtDate(v.last_login_at) : <Badge tone="warn">not yet</Badge>}</td>
                  <td>{fmtDate(v.last_active_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!vets.length && <p className="py-6 text-center text-sm text-muted">No veterinarians match these filters.</p>}
        </div>
      </Section>
    </Page>
  );
}
