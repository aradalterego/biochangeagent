import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { listEscalations } from "@/server/domain/escalations";
import { Badge, Empty, Page, PageHeader, statusTone } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function EscalationsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const sp = await searchParams;
  const rows = await listEscalations(actorFromSession(user), sp.status || null);
  return (
    <Page wide>
      <PageHeader title="Medical Support escalations" subtitle="Questions the agent escalated, with the sources it checked." />
      <div className="mb-4 flex gap-2 text-sm">
        {["", "new", "in_review", "answered", "closed"].map((s) => <a key={s} href={s ? `?status=${s}` : "?"} className={(sp.status ?? "") === s ? "btn-primary" : "btn-secondary"}>{s ? s.replace("_", " ") : "all"}</a>)}
      </div>
      {rows.length ? (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Question</th><th>From</th><th>Product</th><th>Urgency</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-canvas">
                  <td className="max-w-lg"><Link href={`/admin/escalations/${r.id}`} className="text-brand hover:underline">{r.question}</Link></td>
                  <td>{r.user_name}<div className="text-xs text-muted">{r.clinic_name ?? ""}</div></td>
                  <td>{r.product ?? "—"}</td>
                  <td><Badge tone={r.urgency === "urgent" || r.urgency === "high" ? "danger" : "neutral"}>{r.urgency}</Badge></td>
                  <td><Badge tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Badge></td>
                  <td>{fmtDateTime(r.created_at, user.timezone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No escalations.</Empty>
      )}
    </Page>
  );
}
