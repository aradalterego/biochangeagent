import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { listSources, missingCriticalDocuments } from "@/server/knowledge/sources";
import { SOURCE_TYPE_LABELS } from "@/server/knowledge/constants";
import { Badge, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function KnowledgeSourcesPage({ searchParams }: { searchParams: Promise<{ status?: string; product?: string }> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const sp = await searchParams;
  const [sources, missing] = await Promise.all([listSources(actorFromSession(user), { status: sp.status || undefined, product: sp.product || undefined }), missingCriticalDocuments()]);
  return (
    <Page wide>
      <PageHeader title="Knowledge Sources" subtitle="Only APPROVED sources are used by the agent. New sources start as PENDING REVIEW." actions={<Link href="/admin/knowledge/new" className="btn-primary">Add source</Link>} />
      {missing.length > 0 && (
        <div className="mb-5 rounded-xl border border-warn/40 bg-warn-soft px-5 py-4">
          <div className="text-sm font-semibold text-warn">Critical documents still missing ({missing.length})</div>
          <p className="mt-0.5 text-xs text-warn">Public website material alone is not sufficient for a production clinical agent. Upload and approve:</p>
          <ul className="mt-2 grid list-disc gap-x-6 pl-5 text-sm sm:grid-cols-2">{missing.map((m) => <li key={m.key}>{m.title}</li>)}</ul>
        </div>
      )}
      <form className="mb-4 flex gap-2">
        <select name="status" defaultValue={sp.status ?? ""} className="input w-48">
          <option value="">All statuses</option><option value="pending_review">Pending review</option><option value="approved">Approved</option><option value="revoked">Revoked</option><option value="superseded">Superseded</option>
        </select>
        <select name="product" defaultValue={sp.product ?? ""} className="input w-44"><option value="">All products</option><option>ReGum Vet</option><option>MicroFoam</option></select>
        <button className="btn-secondary">Filter</button>
      </form>
      <Section title={`${sources.length} source(s)`}>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Lvl</th><th>Title</th><th>Type</th><th>Product</th><th>Version</th><th>Status</th><th>Content</th><th>Reviewed</th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="hover:bg-canvas">
                  <td className="font-semibold">{s.authority_level}</td>
                  <td className="max-w-md">
                    <Link href={`/admin/knowledge/${s.id}`} className="font-medium text-brand hover:underline">{s.title}</Link>
                    <div className="mt-0.5 flex flex-wrap gap-1">{s.tags.map((t) => <Badge key={t} tone={t === "demo-mock" ? "danger" : "neutral"}>{t}</Badge>)}</div>
                  </td>
                  <td>{SOURCE_TYPE_LABELS[s.source_type]}</td>
                  <td>{s.product ?? "—"}</td>
                  <td>{s.version ?? "—"}</td>
                  <td><Badge tone={statusTone(s.status)}>{s.status.replace("_", " ")}</Badge></td>
                  <td>{s.is_placeholder ? <Badge tone="warn">placeholder</Badge> : s.parse_status === "parsed" ? `${s.chunk_count} passages` : <Badge tone={s.parse_status === "failed" ? "danger" : "neutral"}>{s.parse_status.replace("_", " ")}</Badge>}</td>
                  <td>{fmtDate(s.last_reviewed_at)}<div className="text-xs text-muted">{s.reviewer_name ?? ""}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Page>
  );
}
