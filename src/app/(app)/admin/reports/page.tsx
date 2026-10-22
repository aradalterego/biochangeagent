import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { Page, PageHeader, Section } from "@/components/ui";
import { dashboardFilterOptions } from "@/server/domain/dashboard";
import { REPORT_LABELS, REPORT_TYPES } from "@/server/domain/reports";

/** Report builder: choose a report, filter by product, country and dates, download CSV (opens in Excel / Google Sheets). */
export default async function ReportsPage() {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const opts = await dashboardFilterOptions(actorFromSession(user));
  return (
    <Page>
      <PageHeader title="Reports" subtitle="Filter by product, country and dates, then download. The Veterinarians and All cases pages also download their filtered view." />
      <Section title="Create a report">
        <form action="/api/reports" method="get" className="space-y-5">
          <fieldset>
            <legend className="label">Report</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {REPORT_TYPES.map((t, i) => (
                <label key={t} className="flex cursor-pointer gap-3 rounded-lg border border-line p-3 has-[:checked]:border-brand has-[:checked]:bg-brand-soft/40">
                  <input type="radio" name="type" value={t} defaultChecked={i === 0} className="mt-1" />
                  <span>
                    <span className="block text-sm font-medium">{REPORT_LABELS[t].title}</span>
                    <span className="block text-xs text-muted">{REPORT_LABELS[t].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">Product</label><select name="product" className="input" defaultValue=""><option value="">All products</option>{opts.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div><label className="label">Country</label><select name="country" className="input" defaultValue=""><option value="">All countries</option>{opts.countries.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div><label className="label">From</label><input type="date" name="from" className="input" /></div>
            <div><label className="label">To</label><input type="date" name="to" className="input" /></div>
          </div>
          <p className="text-xs text-muted">
            Dates apply to: {REPORT_TYPES.map((t) => `${REPORT_LABELS[t].title.toLowerCase()} → ${REPORT_LABELS[t].dates}`).join("; ")}.
            Patient references and free-text clinical notes are never included.
          </p>
          <button className="btn-primary">Download report (CSV)</button>
        </form>
      </Section>
    </Page>
  );
}
