import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession, NotFoundError } from "@/lib/authz";
import { sql } from "@/lib/db";
import { getSource } from "@/server/knowledge/sources";
import { isUuid } from "@/server/domain/cases";
import { AUTHORITY_LEVELS, SOURCE_TYPE_LABELS } from "@/server/knowledge/constants";
import {
  addLinkedDocumentAction, approveSourceAction, reparseSourceAction, revokeSourceAction, saveStudyAction, updateSourceAction, uploadSourceFileAction,
} from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { SourceFields } from "@/components/SourceFields";
import { Badge, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function SourceReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const { id } = await params;
  if (!isUuid(id)) notFound();
  let s;
  try {
    s = await getSource(actorFromSession(user), id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const others = await sql<{ id: string; title: string }[]>`
    SELECT id, title FROM knowledge_sources WHERE id <> ${id} AND source_type = ${s.source_type} AND status IN ('approved', 'pending_review') ORDER BY title`;
  const supersededBy = await sql<{ id: string; title: string; status: string }[]>`SELECT id, title, status FROM knowledge_sources WHERE supersedes_source_id = ${id}`;
  const study = s.study as Record<string, string | number | string[] | null> | null;
  const canApprove = !s.is_placeholder && Boolean(s.extracted_text?.trim()) && s.status !== "approved";

  return (
    <Page wide>
      <PageHeader
        title={s.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(s.status)}>{s.status.replace("_", " ")}</Badge>
            <Badge tone="brand">{SOURCE_TYPE_LABELS[s.source_type]}</Badge>
            <Badge>Level {s.authority_level}: {AUTHORITY_LEVELS[s.authority_level]}</Badge>
            {s.is_placeholder && <Badge tone="warn">placeholder — no content</Badge>}
            {s.tags.includes("demo-mock") && <Badge tone="danger">demo mock</Badge>}
            {s.reviewer_name && <span className="text-xs">Reviewed by {s.reviewer_name}, {fmtDateTime(s.last_reviewed_at, user.timezone)}</span>}
          </span>
        }
        actions={<Link href="/admin/knowledge" className="btn-secondary">Back</Link>}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="1. Content">
            {s.is_placeholder ? (
              <p className="mb-3 text-sm text-muted">This is a placeholder for a document that must be uploaded. Upload the approved file below.</p>
            ) : s.parse_status === "failed" ? (
              <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">Parsing failed: {s.parse_error}</p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              {s.storage_path && <a className="btn-secondary" href={`/api/knowledge-files/${s.id}`} target="_blank">Open uploaded file</a>}
              {s.source_url && <a className="btn-secondary" href={s.source_url} target="_blank" rel="noreferrer">Open URL</a>}
              {(s.storage_path || s.source_url) && <ActionForm action={reparseSourceAction.bind(null, s.id)} submitLabel="Re-extract content" submitClassName="btn-secondary" />}
            </div>
            <details className="mt-4" open={s.is_placeholder}>
              <summary className="cursor-pointer text-sm text-brand">Upload a file {s.is_placeholder ? "" : "(creates a new version that supersedes this one when approved)"}</summary>
              <ActionForm action={uploadSourceFileAction.bind(null, s.id)} submitLabel="Upload" submitClassName="btn-secondary" className="mt-3">
                <div className="flex flex-wrap gap-3">
                  <input type="file" name="file" accept=".pdf,.txt,.md" required className="text-sm" />
                  <input name="version" placeholder="Version (e.g. IFU rev. 4)" className="input w-56" />
                </div>
              </ActionForm>
            </details>
            {s.linked_documents.length > 0 && (
              <div className="mt-4">
                <div className="label">Documents linked from this page</div>
                <ul className="space-y-1.5 text-sm">
                  {s.linked_documents.map((d) => (
                    <li key={d.url} className="flex items-center justify-between gap-3">
                      <a href={d.url} target="_blank" rel="noreferrer" className="truncate text-brand hover:underline">{d.url.split("/").pop()}</a>
                      <ActionForm action={addLinkedDocumentAction.bind(null, s.id, d.url)} submitLabel="Add as source" submitClassName="btn-secondary" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <Section title="2. Review metadata and extracted text">
            <ActionForm action={updateSourceAction.bind(null, s.id)} submitLabel="Save review edits">
              <SourceFields s={s} others={others} />
              <div className="mt-4">
                <label className="label">Extracted text (editing approved content returns the source to review). Page markers like [[page 3]] keep page numbers.</label>
                <textarea name="extracted_text" defaultValue={s.extracted_text ?? ""} rows={18} className="input font-mono text-xs" />
              </div>
            </ActionForm>
          </Section>

          {s.source_type === "peer_reviewed_research" && (
            <Section title="Study metadata">
              <ActionForm action={saveStudyAction.bind(null, s.id)} submitLabel="Save study metadata">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["publication", "authors", "journal", "year", "study_design", "sample_size", "intervention", "control", "outcomes", "limitations", "funding_conflicts"] as const).map((k) => (
                    <div key={k} className={["outcomes", "limitations", "study_design"].includes(k) ? "sm:col-span-2" : ""}>
                      <label className="label">{k.replace(/_/g, " ")}</label>
                      <textarea name={k} rows={k === "outcomes" || k === "limitations" ? 3 : 1} defaultValue={study?.[k] != null ? String(study[k]) : ""} className="input" />
                    </div>
                  ))}
                  <div className="sm:col-span-2">
                    <label className="label">Key approved claims (one per line)</label>
                    <textarea name="key_approved_claims" rows={3} defaultValue={Array.isArray(study?.key_approved_claims) ? study.key_approved_claims.join("\n") : ""} className="input" />
                  </div>
                </div>
              </ActionForm>
              <p className="mt-2 text-xs text-muted">Do not turn a single small study into a broad efficacy claim.</p>
            </Section>
          )}
        </div>

        <div>
          <Section title="3. Decision">
            {s.status === "approved" ? (
              <>
                <p className="text-sm text-ok">Approved for agent · {s.chunk_count} indexed passages.</p>
                <ActionForm action={revokeSourceAction.bind(null, s.id)} submitLabel="Revoke" submitClassName="btn-danger mt-3" confirm="Revoke this source? It will immediately stop being used in answers.">
                  <input name="reason" placeholder="Reason" className="input mt-3" />
                </ActionForm>
              </>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted">Approving makes this content available to clinical answers. Check the authority level, product, version and the extracted text first.</p>
                {canApprove ? (
                  <ActionForm action={approveSourceAction.bind(null, s.id)} submitLabel="Approve for agent" confirm="Approve this source for use in agent answers?" />
                ) : (
                  <p className="text-sm text-warn">{s.is_placeholder || !s.extracted_text ? "No reviewable content yet." : `Status: ${s.status}`}</p>
                )}
              </>
            )}
            {s.supersedes_source_id && <p className="mt-3 text-xs text-muted">Supersedes <Link className="text-brand" href={`/admin/knowledge/${s.supersedes_source_id}`}>an older version</Link> when approved.</p>}
            {supersededBy.map((x) => <p key={x.id} className="mt-2 text-xs text-muted">Newer version: <Link className="text-brand" href={`/admin/knowledge/${x.id}`}>{x.title}</Link> ({x.status})</p>)}
          </Section>
          <Section title="Source record">
            <dl className="space-y-1 text-xs text-muted">
              <div>ID: <span className="font-mono">{s.id}</span></div>
              <div>Created: {fmtDateTime(s.created_at, user.timezone)}</div>
              <div>Updated: {fmtDateTime(s.updated_at, user.timezone)}</div>
              <div>File: {s.file_name ?? "—"}</div>
              <div>Parse status: {s.parse_status}</div>
            </dl>
          </Section>
        </div>
      </div>
    </Page>
  );
}
