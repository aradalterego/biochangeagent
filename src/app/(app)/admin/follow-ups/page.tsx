import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { getFollowUpSettings, reminderOverview } from "@/server/domain/followUpReminders";
import { saveFollowUpSettingsAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

const TONE = { sent: "ok", failed: "danger", pending: "warn", sending: "warn", skipped: "neutral" } as const;

export default async function FollowUpSettingsPage() {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const [settings, { counts, recent }] = await Promise.all([getFollowUpSettings(), reminderOverview()]);
  const isAdmin = user.role === "biochange_admin";
  return (
    <Page wide>
      <PageHeader title="Follow-up reminders" subtitle="Every treated case gets a follow-up; the treating veterinarian is emailed when it is due." />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {([["Scheduled", counts.scheduled], ["Due in 30 days", counts.due_30d], ["Overdue", counts.overdue], ["Reminders sent (7 days)", counts.sent_7d], ["Failed sends", counts.failed]] as const).map(([l, v]) => (
          <div key={l} className="card px-4 py-3"><div className="text-xs text-muted">{l}</div><div className={`mt-1 text-2xl font-semibold tabular-nums ${l === "Failed sends" && v ? "text-danger" : ""}`}>{v}</div></div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Section title="Settings">
          {isAdmin ? (
            <ActionForm action={saveFollowUpSettingsAction} submitLabel="Save settings">
              <div className="space-y-3">
                <div><label className="label">Default follow-up (days after treatment)</label><input name="default_days" type="number" min={1} max={730} defaultValue={settings.defaultDays} className="input" required /></div>
                <div><label className="label">Second reminder when overdue by (days, 0 = off)</label><input name="overdue_reminder_days" type="number" min={0} max={365} defaultValue={settings.overdueReminderDays} className="input" required /></div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="reminders_enabled" defaultChecked={settings.remindersEnabled} /> Send reminder emails</label>
              </div>
            </ActionForm>
          ) : (
            <dl className="space-y-1 text-sm">
              <div>Default follow-up: {settings.defaultDays} days after treatment</div>
              <div>Overdue reminder: {settings.overdueReminderDays ? `${settings.overdueReminderDays} days` : "off"}</div>
              <div>Reminder emails: {settings.remindersEnabled ? "on" : "off"}</div>
            </dl>
          )}
          <p className="mt-3 text-xs text-muted">A changed period applies to follow-ups created or moved from now on. A follow-up the veterinarian scheduled themselves replaces the default. Emails contain no clinical findings.</p>
        </Section>
        <div className="lg:col-span-2">
          <Section title="Recent reminder emails">
            {recent.length ? (
              <table className="table">
                <thead><tr><th>Created</th><th>Type</th><th>Recipient</th><th>Status</th><th>Attempts</th><th>Case</th></tr></thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDateTime(r.created_at, user.timezone)}</td>
                      <td>{r.kind === "follow_up_due" ? "due" : "overdue"}</td>
                      <td>{r.recipient ?? "—"}</td>
                      <td><Badge tone={TONE[r.status as keyof typeof TONE] ?? "neutral"}>{r.status}</Badge>{r.last_error && <div className="max-w-xs text-xs text-muted">{r.last_error}</div>}</td>
                      <td>{r.attempts}</td>
                      <td><Link className="text-brand hover:underline" href={`/dashboard/cases/${r.case_id}`}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-sm text-muted">No reminders sent yet.</p>}
          </Section>
        </div>
      </div>
    </Page>
  );
}
