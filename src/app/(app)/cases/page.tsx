import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { searchCases, CASE_STATUSES } from "@/server/domain/cases";
import { Badge, Empty, Page, PageHeader, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function CasesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const user = await requireRole(["veterinarian", "clinic_admin"]);
  const sp = await searchParams;
  const status = sp.status && (CASE_STATUSES as readonly string[]).includes(sp.status) ? sp.status : null;
  const cases = await searchCases(actorFromSession(user), { query: sp.q, status, limit: 200 });
  return (
    <Page wide>
      <PageHeader title="Cases" subtitle="Product-related cases your clinic is managing." actions={<Link href="/cases/new" className="btn-primary">New case</Link>} />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={sp.q} placeholder="Search tooth, patient reference, condition…" className="input max-w-sm" />
        <select name="status" defaultValue={status ?? ""} className="input w-44">
          <option value="">All statuses</option>
          {CASE_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <button className="btn-secondary">Search</button>
      </form>
      {cases.length ? (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Case</th><th>Product</th><th>Condition</th><th>Treated</th><th>Next follow-up</th><th>Status</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} className="hover:bg-canvas">
                  <td><Link href={`/cases/${c.id}`} className="font-medium text-brand hover:underline">{c.tooth ? `Tooth ${c.tooth}` : "Case"}{c.internal_patient_identifier ? ` · ${c.internal_patient_identifier}` : ""}</Link><div className="text-xs text-muted">{c.species}{c.breed ? `, ${c.breed}` : ""}</div></td>
                  <td>{c.product_name ?? "—"}</td>
                  <td className="max-w-xs">{c.condition_summary ?? "—"}{c.pocket_depth_mm ? <span className="text-muted"> · PD {c.pocket_depth_mm} mm</span> : null}</td>
                  <td>{fmtDate(c.treatment_date)}</td>
                  <td>{fmtDate(c.next_follow_up)}</td>
                  <td><Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, " ")}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No cases found.</Empty>
      )}
    </Page>
  );
}
