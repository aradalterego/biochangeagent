import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession, NotFoundError } from "@/lib/authz";
import { getEscalation } from "@/server/domain/escalations";
import { isUuid } from "@/server/domain/cases";
import { convertEscalationAction, escalationAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Field, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function EscalationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const { id } = await params;
  if (!isUuid(id)) notFound();
  let r;
  try {
    r = await getEscalation(actorFromSession(user), id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const sources = (r.sources_checked ?? []) as { sourceId: string; title: string }[];
  return (
    <Page>
      <PageHeader title="Medical Support request" subtitle={<span className="flex items-center gap-2"><Badge tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Badge> {r.urgency} · {fmtDateTime(r.created_at, user.timezone)}</span>} actions={<Link href="/admin/escalations" className="btn-secondary">Back</Link>} />
      <Section title="Question">
        <p className="whitespace-pre-wrap text-sm">{r.question}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="From">{`${r.user_name} (${r.user_email})`}</Field>
          <Field label="Clinic">{r.clinic_name}</Field>
          <Field label="Product">{r.product}</Field>
        </div>
      </Section>
      <Section title="Agent summary & sources checked">
        <p className="whitespace-pre-wrap text-sm">{r.agent_summary ?? "—"}</p>
        {sources.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{sources.map((s) => <li key={s.sourceId}><Link className="text-brand" href={`/admin/knowledge/${s.sourceId}`}>{s.title}</Link></li>)}</ul>}
        {r.case_id && (
          <div className="mt-4 rounded-lg bg-canvas p-3 text-sm">
            <div className="label">Case context</div>
            Tooth {r.case_tooth ?? "—"} · {r.case_condition ?? "—"} · PD {r.case_pocket_depth ?? "—"} mm · {r.case_procedure ?? "—"}
          </div>
        )}
      </Section>
      <Section title="Answer">
        <ActionForm action={escalationAction.bind(null, r.id)} submitLabel="Save">
          <textarea name="answer" rows={6} defaultValue={r.answer ?? ""} className="input" placeholder="Approved Medical Support answer" />
          <div className="mt-3 w-48">
            <label className="label">Status</label>
            <select name="status" defaultValue={r.status === "new" ? "in_review" : r.status} className="input">
              <option value="in_review">in review</option><option value="answered">answered</option><option value="closed">closed</option><option value="new">new</option>
            </select>
          </div>
        </ActionForm>
        {r.answer && (
          <div className="mt-5 border-t border-line pt-4">
            {r.converted_source_id ? (
              <p className="text-sm">Converted to <Link className="text-brand" href={`/admin/knowledge/${r.converted_source_id}`}>knowledge source</Link> (requires review before use).</p>
            ) : (
              <ActionForm action={convertEscalationAction.bind(null, r.id)} submitLabel="Convert to knowledge source (pending review)" submitClassName="btn-secondary" />
            )}
          </div>
        )}
      </Section>
    </Page>
  );
}
