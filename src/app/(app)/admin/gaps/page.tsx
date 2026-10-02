import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { sql } from "@/lib/db";
import { listKnowledgeGaps } from "@/server/domain/gaps";
import { gapAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty, Page, PageHeader } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function GapsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const sp = await searchParams;
  const status = ["open", "resolved", "dismissed"].includes(sp.status ?? "") ? sp.status! : "open";
  const gaps = await listKnowledgeGaps(actorFromSession(user), status);
  const sources = await sql<{ id: string; title: string }[]>`SELECT id, title FROM knowledge_sources WHERE status = 'approved' ORDER BY title`;
  return (
    <Page wide>
      <PageHeader title="Knowledge Gaps" subtitle="Professional questions the agent could not answer from approved knowledge — what veterinarians actually need to know." />
      <div className="mb-4 flex gap-2 text-sm">
        {["open", "resolved", "dismissed"].map((s) => <a key={s} href={`?status=${s}`} className={s === status ? "btn-primary" : "btn-secondary"}>{s}</a>)}
      </div>
      {gaps.length ? (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Question</th><th>Product</th><th>Asked</th><th>Users</th><th>Last</th><th>Reason</th><th>Escalated</th><th></th></tr></thead>
            <tbody>
              {gaps.map((g) => (
                <tr key={g.id}>
                  <td className="max-w-md">{g.question}</td>
                  <td>{g.product ?? "—"}</td>
                  <td className="font-semibold">{g.frequency}×</td>
                  <td>{g.user_count}</td>
                  <td>{fmtDate(g.last_seen_at)}</td>
                  <td className="max-w-xs text-muted">{g.reason_unresolved}</td>
                  <td>{g.escalated ? <Badge tone="brand">yes</Badge> : "no"}</td>
                  <td>
                    {status === "open" ? (
                      <div className="flex flex-col gap-2">
                        <ActionForm action={gapAction.bind(null, g.id, "resolved")} submitLabel="Resolved by" submitClassName="btn-secondary">
                          <select name="source_id" className="input w-56"><option value="">(no source)</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.title.slice(0, 60)}</option>)}</select>
                        </ActionForm>
                        <ActionForm action={gapAction.bind(null, g.id, "dismissed")} submitLabel="Dismiss" submitClassName="btn-secondary" />
                      </div>
                    ) : (
                      <span className="text-xs text-muted">{g.resolved_source_title ?? ""}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No {status} knowledge gaps.</Empty>
      )}
    </Page>
  );
}
