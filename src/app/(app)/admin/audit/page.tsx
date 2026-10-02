import { requireRole } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { Badge, Page, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ entity?: string; action?: string }> }) {
  const user = await requireRole(["biochange_admin"]);
  const sp = await searchParams;
  const entity = sp.entity?.trim() || null;
  const action = sp.action?.trim() ? `${sp.action.trim()}%` : null;
  const rows = await sql<{ id: number; timestamp: Date; user_name: string | null; action: string; entity_type: string; entity_id: string | null; tool: string | null; input_summary: string | null; result: string; source_message_id: string | null }[]>`
    SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE (${entity}::text IS NULL OR a.entity_type = ${entity}) AND (${action}::text IS NULL OR a.action LIKE ${action})
    ORDER BY a.timestamp DESC LIMIT 300`;
  return (
    <Page wide>
      <PageHeader title="Audit Log" subtitle="Every meaningful mutation: cases, inventory, orders, follow-ups, profile, knowledge approval, escalations." />
      <form className="mb-4 flex gap-2">
        <input name="entity" defaultValue={sp.entity} placeholder="entity type (e.g. case)" className="input w-52" />
        <input name="action" defaultValue={sp.action} placeholder="action prefix (e.g. order.)" className="input w-52" />
        <button className="btn-secondary">Filter</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Via</th><th>Details</th><th>Result</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{fmtDateTime(r.timestamp, user.timezone)}</td>
                <td>{r.user_name ?? "system"}</td>
                <td className="font-mono text-xs">{r.action}</td>
                <td className="text-xs">{r.entity_type}<div className="font-mono text-muted">{r.entity_id?.slice(0, 8)}</div></td>
                <td className="text-xs">{r.tool}{r.source_message_id && <div className="text-muted">from chat</div>}</td>
                <td className="max-w-md text-xs text-muted">{r.input_summary}</td>
                <td><Badge tone={r.result === "success" ? "ok" : "danger"}>{r.result}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
