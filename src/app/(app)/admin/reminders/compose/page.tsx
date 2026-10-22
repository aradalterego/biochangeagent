import { requireRole } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { composeEmailAction } from "@/app/actions/engagement";
import { ActionForm } from "@/components/ActionForm";
import { ComposeFields } from "@/components/ComposeFields";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { MERGE_TAGS, listOutboundEmails, listTemplates } from "@/server/domain/engagement";

const TONE = { sent: "ok", failed: "danger", pending: "warn", sending: "warn", skipped: "neutral" } as const;

/** Write an email (plain or from a template) to chosen veterinarians or a segment. */
export default async function ComposePage() {
  const user = await requireRole(["biochange_admin"]);
  const e = env();
  const [vets, products, templates, sent] = await Promise.all([
    sql<{ id: string; name: string; email: string; country: string | null; is_customer: boolean }[]>`
      SELECT u.id, u.name, u.email, coalesce(u.country, c.country) AS country, u.is_customer
      FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id WHERE u.active AND u.role IN ('veterinarian', 'clinic_admin') ORDER BY u.name`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM products WHERE active ORDER BY name`,
    listTemplates(),
    listOutboundEmails({ kind: "direct", limit: 50 }),
  ]);
  const countries = [...new Set(vets.map((v) => v.country).filter((c): c is string => Boolean(c)))].sort();
  const live = e.EMAIL_DRIVER === "resend";
  return (
    <Page wide>
      <PageHeader title="Write email" subtitle="Send a plain email or a template to veterinarians. Every email is logged and failed sends are retried." />
      {!live && (
        <div className="mb-5 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
          Email sending is not connected yet (EMAIL_DRIVER={e.EMAIL_DRIVER}). Emails are recorded here{e.EMAIL_DRIVER === "log" ? " and printed to the server log" : ""} but not delivered.
          They go out from your address once <code>EMAIL_DRIVER=resend</code>, <code>RESEND_API_KEY</code> and <code>MARKETING_EMAIL_FROM</code> are set at launch.
        </div>
      )}
      <Section title="New email">
        <ActionForm action={composeEmailAction} submitLabel="Send email" confirm="Send this email now?">
          <ComposeFields vets={vets} countries={countries} products={products} templates={templates} mergeTags={MERGE_TAGS} sender={e.MARKETING_EMAIL_FROM || e.EMAIL_FROM} />
        </ActionForm>
      </Section>
      <Section title="Sent emails">
        {sent.length ? (
          <table className="table">
            <thead><tr><th>Sent</th><th>Recipient</th><th>Subject</th><th>Status</th></tr></thead>
            <tbody>
              {sent.map((m) => (
                <tr key={m.id}>
                  <td>{fmtDateTime(m.sent_at ?? m.created_at, user.timezone)}</td>
                  <td>{m.recipient ?? "—"}<div className="text-xs text-muted">{m.to_email}</div></td>
                  <td className="max-w-md truncate">{m.subject}</td>
                  <td><Badge tone={TONE[m.status as keyof typeof TONE] ?? "neutral"}>{m.status}</Badge>{m.last_error && <div className="max-w-xs text-xs text-muted">{m.last_error}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-muted">No emails written yet.</p>}
      </Section>
    </Page>
  );
}
