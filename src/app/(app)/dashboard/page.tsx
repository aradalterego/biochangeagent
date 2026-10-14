import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { dashboardOverview } from "@/server/domain/dashboard";
import { Badge, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { FollowUpBadge } from "@/components/FollowUpBadge";
import { fmtDate } from "@/lib/format";

export default async function DashboardPage() {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const { totals, byStatus, recent } = await dashboardOverview(actorFromSession(user));
  const tiles: [string, string | number, string?][] = [
    ["Veterinarians", totals.vets, "/dashboard/vets"],
    ["Active (30 days)", totals.active_vets_30d],
    ["Vets with cases", totals.vets_with_cases],
    ["Cases", totals.cases, "/dashboard/cases"],
    ["Treated (30 days)", totals.treated_30d],
    ["Follow-ups overdue", totals.overdue, "/dashboard/cases?follow_up=overdue"],
    ["Follow-ups missing", totals.missing, "/dashboard/cases?follow_up=missing"],
    ["Feedback entries", totals.feedback],
    ["Avg product rating", totals.avg_product ?? "—"],
    ["Avg ease of use", totals.avg_ease ?? "—"],
  ];
  return (
    <Page wide>
      <PageHeader title="Clinical data dashboard" subtitle="All participating veterinarians and cases. Read-only." actions={<Link href="/dashboard/cases" className="btn-primary">All cases</Link>} />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles.map(([label, value, href]) => {
          const body = (
            <>
              <div className="text-xs text-muted">{label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
            </>
          );
          return href ? (
            <Link key={label} href={href} className="card px-4 py-3 hover:border-brand">{body}</Link>
          ) : (
            <div key={label} className="card px-4 py-3">{body}</div>
          );
        })}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Recent activity">
            <table className="table">
              <thead><tr><th>Case</th><th>Veterinarian</th><th>Status</th><th>Follow-up</th><th>Last activity</th></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/dashboard/cases/${r.id}`} className="text-brand hover:underline">{r.product_name ?? "Case"}{r.tooth ? ` · tooth ${r.tooth}` : ""}</Link><div className="text-xs text-muted">{r.clinic_name}</div></td>
                    <td>{r.vet_name ?? "—"}</td>
                    <td><Badge tone={statusTone(r.status)}>{r.status.replace(/_/g, " ")}</Badge></td>
                    <td><FollowUpBadge state={r.follow_up_state} /></td>
                    <td>{fmtDate(r.last_activity_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!recent.length && <p className="text-sm text-muted">No cases yet.</p>}
          </Section>
        </div>
        <Section title="Cases by status">
          <ul className="space-y-1.5 text-sm">
            {byStatus.map((s) => (
              <li key={s.status} className="flex justify-between">
                <Link href={`/dashboard/cases?status=${s.status}`} className="text-brand hover:underline">{s.status.replace(/_/g, " ")}</Link>
                <span className="tabular-nums">{s.n}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </Page>
  );
}
