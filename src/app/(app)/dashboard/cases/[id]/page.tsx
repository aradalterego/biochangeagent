import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession, NotFoundError } from "@/lib/authz";
import { sql } from "@/lib/db";
import { getCase } from "@/server/domain/cases";
import { Badge, Field, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { FeedbackList } from "@/components/FeedbackList";
import { FollowUpMeta } from "@/components/FollowUpMeta";
import { fmtDate, fmtDateTime } from "@/lib/format";

/** Read-only case view for BioChange staff (no edit forms; writes are refused server-side anyway). */
export default async function DashboardCasePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const { id } = await params;
  let data;
  try {
    data = await getCase(actorFromSession(user), id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const { case: c, notes, followUps, measurements, files, feedback } = data;
  const [clinic] = await sql<{ name: string; country: string | null }[]>`SELECT name, country FROM clinics WHERE id = ${c.clinic_id}`;
  return (
    <Page wide>
      <PageHeader
        title={`${c.product_name ?? "Case"}${c.tooth ? ` · tooth ${c.tooth}` : ""}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, " ")}</Badge> {clinic?.name}{clinic?.country ? ` (${clinic.country})` : ""} · {c.created_by_name ?? "—"} · created {fmtDate(c.created_at)} · updated {fmtDate(c.updated_at)}</span>}
        actions={<Link href="/dashboard/cases" className="btn-secondary">Back</Link>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Clinical data">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Species / breed / age">{[c.species, c.breed, c.age].filter(Boolean).join(" · ")}</Field>
              <Field label="Condition">{c.condition_summary}</Field>
              <Field label="Defect / furcation">{[c.defect_type, c.furcation].filter(Boolean).join(" · ") || null}</Field>
              <Field label="Procedure">{c.procedure_type}</Field>
              <Field label="Product">{c.product_name ? `${c.product_name}${c.product_variant ? ` (${c.product_variant})` : ""}` : null}</Field>
              <Field label="Treatment date">{fmtDate(c.treatment_date)}</Field>
              <Field label="Goal">{c.treatment_goal}</Field>
              <Field label="Baseline notes">{c.baseline_notes}</Field>
              <Field label="Outcome">{c.outcome_notes}</Field>
            </div>
          </Section>
          <Section title="Measurements">
            {measurements.length ? (
              <table className="table">
                <thead><tr><th>Date</th><th>Type</th><th>Tooth</th><th>PD (mm)</th><th>Attachment (mm)</th><th>Furcation</th><th>Mobility</th></tr></thead>
                <tbody>
                  {measurements.map((m) => (
                    <tr key={m.id}><td>{fmtDate(m.measured_at)}</td><td>{m.kind.replace("_", "-")}</td><td>{m.tooth ?? "—"}</td><td>{m.pocket_depth_mm ?? "—"}</td><td>{m.attachment_level_mm ?? "—"}</td><td>{m.furcation ?? "—"}</td><td>{m.mobility ?? "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-sm text-muted">No measurements.</p>}
          </Section>
          <Section title="Feedback"><FeedbackList feedback={feedback} timezone={user.timezone} /></Section>
          <Section title="Notes">
            {notes.length ? (
              <ul className="space-y-2">
                {notes.map((n) => (
                  <li key={n.id} className="rounded-lg bg-canvas px-3 py-2 text-sm"><div className="whitespace-pre-wrap">{n.content}</div><div className="mt-1 text-xs text-muted">{n.author ?? "—"} · {fmtDateTime(n.created_at, user.timezone)}</div></li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No notes.</p>}
          </Section>
        </div>
        <div>
          <Section title="Follow-ups">
            {followUps.length ? (
              <ul className="space-y-2 text-sm">
                {followUps.map((f) => (
                  <li key={f.id} className="flex items-center justify-between"><span>{fmtDate(f.due_at)}{f.reason ? <span className="text-muted"> · {f.reason}</span> : null}<FollowUpMeta f={f} /></span><Badge tone={statusTone(f.status)}>{f.status}</Badge></li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No follow-up scheduled.</p>}
          </Section>
          <Section title="Files">
            {files.length ? (
              <ul className="space-y-1 text-sm">
                {files.map((f) => (
                  <li key={f.id}><a href={`/api/case-files/${f.id}`} target="_blank" className="break-all text-brand hover:underline">{f.file_name}</a> <span className="text-xs text-muted">· {f.file_type.replace("_", " ")} · {fmtDate(f.uploaded_at)}</span></li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No files.</p>}
            <p className="mt-2 text-xs text-muted">Files may contain identifying information despite the upload guidance. Handle them as confidential and do not forward them.</p>
          </Section>
        </div>
      </div>
    </Page>
  );
}
