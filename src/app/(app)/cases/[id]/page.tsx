import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { actorFromSession, NotFoundError, AuthorizationError } from "@/lib/authz";
import { getCase } from "@/server/domain/cases";
import { listProducts } from "@/server/domain/products";
import {
  addNoteAction, closeCaseAction, completeFollowUpAction, recordUsageAction, scheduleFollowUpAction, updateCaseAction, uploadCaseFileAction,
} from "@/app/actions/cases";
import { ActionForm } from "@/components/ActionForm";
import { CaseFields } from "@/components/CaseFields";
import { Badge, Field, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(["veterinarian", "clinic_admin"]);
  const { id } = await params;
  let data;
  try {
    data = await getCase(actorFromSession(user), id);
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof AuthorizationError) notFound();
    throw e;
  }
  const products = await listProducts();
  const { case: c, notes, followUps, measurements, files, conversations, usage } = data;
  const scheduled = followUps.filter((f) => f.status === "scheduled");
  const title = `${c.tooth ? `Tooth ${c.tooth}` : "Case"}${c.internal_patient_identifier ? ` · ${c.internal_patient_identifier}` : ""}`;

  return (
    <Page wide>
      <PageHeader
        title={title}
        subtitle={<span className="flex items-center gap-2"><Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, " ")}</Badge> {c.species}{c.breed ? ` · ${c.breed}` : ""}{c.age ? ` · ${c.age}` : ""} · created by {c.created_by_name ?? "—"}</span>}
        actions={<Link href={`/chat?case=${c.id}`} className="btn-primary">Ask the companion about this case</Link>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Baseline & treatment">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Condition">{c.condition_summary}</Field>
              <Field label="Pocket depth (baseline)">{c.pocket_depth_mm ? `${c.pocket_depth_mm} mm` : null}</Field>
              <Field label="Defect / furcation">{[c.defect_type, c.furcation].filter(Boolean).join(" · ") || null}</Field>
              <Field label="Procedure">{c.procedure_type}</Field>
              <Field label="Product">{c.product_name ? `${c.product_name}${c.product_variant ? ` (${c.product_variant})` : ""}` : null}</Field>
              <Field label="Treatment date">{fmtDate(c.treatment_date)}</Field>
              <Field label="Goal">{c.treatment_goal}</Field>
              <Field label="Baseline notes">{c.baseline_notes}</Field>
              <Field label="Outcome">{c.outcome_notes}</Field>
            </div>
          </Section>

          <Section title="Measurements — baseline vs follow-up">
            {measurements.length ? (
              <table className="table">
                <thead><tr><th>Date</th><th>Type</th><th>Tooth</th><th>PD (mm)</th><th>Attachment (mm)</th><th>Furcation</th><th>Mobility</th><th>Notes</th></tr></thead>
                <tbody>
                  {measurements.map((m) => (
                    <tr key={m.id}>
                      <td>{fmtDate(m.measured_at)}</td>
                      <td><Badge tone={m.kind === "baseline" ? "neutral" : "brand"}>{m.kind.replace("_", "-")}</Badge></td>
                      <td>{m.tooth ?? "—"}</td>
                      <td>{m.pocket_depth_mm ?? "—"}</td>
                      <td>{m.attachment_level_mm ?? "—"}</td>
                      <td>{m.furcation ?? "—"}</td>
                      <td>{m.mobility ?? "—"}</td>
                      <td className="max-w-xs text-muted">{m.notes ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">No measurements recorded.</p>
            )}
          </Section>

          <Section title="Follow-ups">
            {followUps.length > 0 && (
              <ul className="mb-4 space-y-3">
                {followUps.map((f) => (
                  <li key={f.id} className="rounded-lg border border-line p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{fmtDate(f.due_at)} {f.reason ? <span className="font-normal text-muted">· {f.reason}</span> : null}</span>
                      <Badge tone={statusTone(f.status)}>{f.status}</Badge>
                    </div>
                    {f.status === "scheduled" && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm text-brand">Record follow-up result</summary>
                        <ActionForm action={completeFollowUpAction.bind(null, c.id, f.id)} submitLabel="Save follow-up" className="mt-3">
                          <div className="grid gap-3 sm:grid-cols-4">
                            <div><label className="label">PD (mm)</label><input name="pocket_depth_mm" type="number" step="0.5" className="input" /></div>
                            <div><label className="label">Attachment (mm)</label><input name="attachment_level_mm" type="number" step="0.5" className="input" /></div>
                            <div><label className="label">Furcation</label><input name="furcation" className="input" /></div>
                            <div><label className="label">Mobility</label><input name="mobility" className="input" /></div>
                            <div className="sm:col-span-4"><label className="label">Outcome</label><input name="outcome" className="input" placeholder="e.g. healed, PD reduced" /></div>
                            <div className="sm:col-span-4"><label className="label">Notes</label><textarea name="notes" rows={2} className="input" /></div>
                          </div>
                        </ActionForm>
                      </details>
                    )}
                    {f.notes && <p className="mt-1 text-sm text-muted">{f.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={scheduleFollowUpAction.bind(null, c.id)} submitLabel="Schedule follow-up" submitClassName="btn-secondary" resetOnSuccess>
              <div className="grid gap-3 sm:grid-cols-3">
                <div><label className="label">Due date</label><input name="due_at" type="date" required className="input" /></div>
                <div className="sm:col-span-2"><label className="label">Reason</label><input name="reason" className="input" placeholder="e.g. 3-month recheck" /></div>
              </div>
            </ActionForm>
            {!scheduled.length && c.status !== "closed" && <p className="mt-2 text-xs text-muted">No follow-up scheduled.</p>}
          </Section>

          <Section title="Notes">
            <ul className="mb-4 space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="rounded-lg bg-canvas px-3 py-2 text-sm">
                  <div className="whitespace-pre-wrap">{n.content}</div>
                  <div className="mt-1 text-xs text-muted">{n.author ?? "—"} · {fmtDateTime(n.created_at, user.timezone)}</div>
                </li>
              ))}
            </ul>
            <ActionForm action={addNoteAction.bind(null, c.id)} submitLabel="Add note" submitClassName="btn-secondary" resetOnSuccess>
              <textarea name="note" rows={2} className="input" required />
            </ActionForm>
          </Section>

          <Section title="Edit case">
            <details>
              <summary className="cursor-pointer text-sm text-brand">Edit case details</summary>
              <div className="mt-4">
                <ActionForm action={updateCaseAction.bind(null, c.id)} submitLabel="Save changes">
                  <CaseFields c={c} products={products} />
                  <div className="mt-4"><label className="label">Outcome notes</label><textarea name="outcome_notes" defaultValue={c.outcome_notes ?? ""} rows={2} className="input" /></div>
                </ActionForm>
              </div>
            </details>
          </Section>
        </div>

        <div>
          <Section title="Product usage">
            {usage.length ? (
              <ul className="mb-3 space-y-1 text-sm">
                {usage.map((u, i) => <li key={i}>{u.quantity} × {u.product} <span className="text-muted">· {fmtDate(u.created_at)}</span></li>)}
              </ul>
            ) : (
              <p className="mb-3 text-sm text-muted">No usage recorded on this case.</p>
            )}
            <ActionForm action={recordUsageAction.bind(null, c.id)} submitLabel="Record usage" submitClassName="btn-secondary">
              <div className="flex gap-2">
                <select name="product" defaultValue={c.product_name ?? products[0]?.name} className="input">
                  {products.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
                <input name="quantity" type="number" min={1} defaultValue={1} className="input w-20" />
              </div>
            </ActionForm>
            <p className="mt-2 text-xs text-muted">Lowers the clinic&apos;s estimated stock.</p>
          </Section>

          <Section title="Files">
            {files.length ? (
              <ul className="mb-3 space-y-1 text-sm">
                {files.map((f) => (
                  <li key={f.id}>
                    <a href={`/api/case-files/${f.id}`} target="_blank" className="text-brand hover:underline">{f.file_name}</a>
                    <span className="text-xs text-muted"> · {f.file_type.replace("_", " ")}</span>
                    {f.description && <div className="text-xs text-muted">{f.description}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-3 text-sm text-muted">No files.</p>
            )}
            <ActionForm action={uploadCaseFileAction.bind(null, c.id)} submitLabel="Upload" submitClassName="btn-secondary" resetOnSuccess>
              <div className="space-y-2">
                <input type="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.dcm" className="block w-full text-sm" />
                <select name="file_type" className="input">
                  <option value="radiograph">Radiograph</option>
                  <option value="clinical_image">Clinical image</option>
                  <option value="document">Document</option>
                  <option value="other">Other</option>
                </select>
                <input name="description" placeholder="Description" className="input" />
              </div>
            </ActionForm>
            <p className="mt-2 text-xs text-muted">Stored privately. Images are not interpreted automatically.</p>
          </Section>

          <Section title="Conversations">
            {conversations.length ? (
              <ul className="space-y-1 text-sm">
                {conversations.map((cv) => (
                  <li key={cv.id}><Link href={`/chat/${cv.id}`} className="text-brand hover:underline">{cv.title ?? "Conversation"}</Link> <span className="text-xs text-muted">{fmtDate(cv.last_message_at)}</span></li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No linked conversations.</p>
            )}
          </Section>

          {c.status !== "closed" && (
            <Section title="Close case">
              <ActionForm action={closeCaseAction.bind(null, c.id)} submitLabel="Close case" submitClassName="btn-danger" confirm="Close this case? Remaining follow-ups will be cancelled.">
                <textarea name="outcome_notes" rows={2} className="input" placeholder="Final outcome (optional)" />
              </ActionForm>
            </Section>
          )}
        </div>
      </div>
    </Page>
  );
}
