import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { CASE_STATUSES } from "@/server/domain/cases";
import { FOLLOW_UP_STATES, PAGE_SIZE, dashboardFilterOptions, filtersFromParams, listDashboardCases } from "@/server/domain/dashboard";
import { Badge, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { FollowUpBadge } from "@/components/FollowUpBadge";
import { fmtDate } from "@/lib/format";

type SP = Record<string, string | string[] | undefined>;

export default async function DashboardCasesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const actor = actorFromSession(user);
  const sp = await searchParams;
  const f = filtersFromParams(sp);
  const [{ rows, total, page }, opts] = await Promise.all([listDashboardCases(actor, f), dashboardFilterOptions(actor)]);
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) p.set(k, v);
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    return `?${p}`;
  };
  const sortLink = (key: string, label: string) => {
    const active = (f.sort ?? "activity") === key;
    const dir = active && f.dir === "desc" ? "asc" : "desc";
    return <Link href={`/dashboard/cases${qs({ sort: key, dir, page: null })}`} className={active ? "text-ink" : "hover:text-ink"}>{label}{active ? (f.dir === "asc" ? " ↑" : " ↓") : ""}</Link>;
  };
  const exportHref = `/api/dashboard/export${qs({ page: null })}`;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Page wide>
      <PageHeader title="All cases" subtitle={`${total} case(s) across all clinics. Read-only.`} actions={<a href={exportHref} className="btn-secondary">Export CSV</a>} />
      <form className="card mb-5 grid gap-3 p-4 sm:grid-cols-4 lg:grid-cols-8">
        <input name="q" defaultValue={f.q ?? ""} placeholder="Search tooth, condition, vet…" className="input lg:col-span-2" />
        <select name="status" defaultValue={f.status ?? ""} className="input"><option value="">All statuses</option>{CASE_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select>
        <select name="follow_up" defaultValue={f.followUp ?? ""} className="input"><option value="">Any follow-up</option>{FOLLOW_UP_STATES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
        <select name="product" defaultValue={f.productId ?? ""} className="input"><option value="">All products</option>{opts.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select name="clinic" defaultValue={f.clinicId ?? ""} className="input"><option value="">All clinics</option>{opts.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select name="vet" defaultValue={f.vetId ?? ""} className="input"><option value="">All veterinarians</option>{opts.vets.map((v) => <option key={v.id} value={v.id}>{v.name}{v.clinic ? ` (${v.clinic})` : ""}</option>)}</select>
        <div className="flex gap-2 lg:col-span-2">
          <input type="date" name="from" defaultValue={f.treatedFrom ?? ""} className="input" aria-label="Treated from" title="Treated from" />
          <input type="date" name="to" defaultValue={f.treatedTo ?? ""} className="input" aria-label="Treated to" title="Treated to" />
        </div>
        <input type="hidden" name="sort" value={f.sort ?? ""} />
        <input type="hidden" name="dir" value={f.dir ?? ""} />
        <div className="flex gap-2">
          <button className="btn-primary">Filter</button>
          <Link href="/dashboard/cases" className="btn-secondary">Reset</Link>
        </div>
      </form>
      <Section title={`Page ${page} of ${pages}`}>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Case</th><th>{sortLink("clinic", "Clinic")}</th><th>{sortLink("vet", "Veterinarian")}</th><th>{sortLink("status", "Status")}</th>
                <th>{sortLink("treatment", "Treated")}</th><th>{sortLink("follow_up", "Follow-up")}</th><th>PD (mm)</th><th>Feedback</th>
                <th>{sortLink("created", "Created")}</th><th>{sortLink("activity", "Last activity")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-canvas">
                  <td className="max-w-xs">
                    <Link href={`/dashboard/cases/${r.id}`} className="font-medium text-brand hover:underline">{r.product_name ?? "No product"}{r.tooth ? ` · tooth ${r.tooth}` : ""}</Link>
                    <div className="truncate text-xs text-muted">{[r.species, r.defect_type, r.procedure_type].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>{r.clinic_name}<div className="text-xs text-muted">{r.clinic_country ?? ""}</div></td>
                  <td>{r.vet_name ?? "—"}</td>
                  <td><Badge tone={statusTone(r.status)}>{r.status.replace(/_/g, " ")}</Badge></td>
                  <td>{fmtDate(r.treatment_date)}</td>
                  <td><FollowUpBadge state={r.follow_up_state} />{r.next_follow_up && <div className="text-xs text-muted">{fmtDate(r.next_follow_up)}</div>}</td>
                  <td className="tabular-nums">{r.baseline_pd ?? "—"}{r.latest_follow_up_pd ? ` → ${r.latest_follow_up_pd}` : ""}</td>
                  <td>{r.feedback_count ? `${r.feedback_count}${r.avg_product_rating ? ` · ${r.avg_product_rating}/5` : ""}` : "—"}</td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td>{fmtDate(r.last_activity_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="py-6 text-center text-sm text-muted">No cases match these filters.</p>}
        </div>
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            {page > 1 ? <Link href={`/dashboard/cases${qs({ page: String(page - 1) })}`} className="btn-secondary">Previous</Link> : <span />}
            {page < pages ? <Link href={`/dashboard/cases${qs({ page: String(page + 1) })}`} className="btn-secondary">Next</Link> : <span />}
          </div>
        )}
      </Section>
    </Page>
  );
}
