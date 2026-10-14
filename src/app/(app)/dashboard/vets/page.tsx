import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { listDashboardVets } from "@/server/domain/dashboard";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function DashboardVetsPage() {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const vets = await listDashboardVets(actorFromSession(user));
  return (
    <Page wide>
      <PageHeader title="Veterinarians" subtitle={`${vets.length} participating veterinarian(s).`} />
      <Section title="All veterinarians">
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Name</th><th>Clinic</th><th>Cases</th><th>Open</th><th>Follow-up overdue</th><th>Follow-up missing</th><th>Feedback</th><th>Last sign-in</th><th>Last active</th></tr></thead>
            <tbody>
              {vets.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}{!v.active && <> <Badge tone="danger">inactive</Badge></>}<div className="text-xs text-muted">{v.email}</div></td>
                  <td>{v.clinic ?? "—"}<div className="text-xs text-muted">{v.country ?? ""}</div></td>
                  <td>{v.cases ? <Link className="text-brand hover:underline" href={`/dashboard/cases?vet=${v.id}`}>{v.cases}</Link> : 0}</td>
                  <td>{v.open_cases}</td>
                  <td>{v.overdue ? <Link className="text-danger hover:underline" href={`/dashboard/cases?vet=${v.id}&follow_up=overdue`}>{v.overdue}</Link> : 0}</td>
                  <td>{v.missing ? <Link className="text-danger hover:underline" href={`/dashboard/cases?vet=${v.id}&follow_up=missing`}>{v.missing}</Link> : 0}</td>
                  <td>{v.feedback}</td>
                  <td>{v.last_login_at ? fmtDate(v.last_login_at) : <Badge tone="warn">not yet</Badge>}</td>
                  <td>{fmtDate(v.last_active_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Page>
  );
}
