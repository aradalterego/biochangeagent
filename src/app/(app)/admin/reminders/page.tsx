import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { createRuleAction, runRulesNowAction, setRuleActiveAction } from "@/app/actions/engagement";
import { ActionForm } from "@/components/ActionForm";
import { RuleFields } from "@/components/RuleFields";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { AUDIENCE_LABELS, REMINDER_TYPE_LABELS, TRIGGER_LABELS, describeSchedule, engagementCounts, listOutboundEmails, listRules } from "@/server/domain/engagement";
import { ruleFormOptions } from "@/server/domain/engagementOptions";

const TONE = { sent: "ok", failed: "danger", pending: "warn", sending: "warn", skipped: "neutral" } as const;

/** Reminder rules: type, trigger event, interval, audience, email and optional feedback-for-discount offer. */
export default async function RemindersPage() {
  const user = await requireRole(["biochange_admin"]);
  const [rules, counts, recent, options] = await Promise.all([listRules(), engagementCounts(), listOutboundEmails({ kind: "rule", limit: 30 }), ruleFormOptions()]);
  return (
    <Page wide>
      <PageHeader
        title="Reminders & emails"
        subtitle="Automatic emails after a trigger event: a purchase, a product used in a case, a question to the AI agent, or registration."
        actions={<ActionForm action={runRulesNowAction} submitLabel="Run rules now" submitClassName="btn-secondary" />}
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-6">
        {([["Active rules", counts.active_rules], ["Emails sent (7 days)", counts.sent_7d], ["Queued", counts.pending], ["Failed", counts.failed], ["Open offers", counts.offers_open], ["Discount codes issued", counts.codes_issued]] as const).map(([l, v]) => (
          <div key={l} className="card px-4 py-3"><div className="text-xs text-muted">{l}</div><div className={`mt-1 text-2xl font-semibold tabular-nums ${l === "Failed" && v ? "text-danger" : ""}`}>{v}</div></div>
        ))}
      </div>
      <Section title="Rules">
        {rules.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Rule</th><th>Trigger</th><th>When</th><th>Audience</th><th>Offer</th><th>Sent</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/admin/reminders/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link><div className="text-xs text-muted">{REMINDER_TYPE_LABELS[r.reminder_type]}</div></td>
                    <td>{TRIGGER_LABELS[r.trigger_event]}<div className="text-xs text-muted">{r.product ?? "Any product"}</div></td>
                    <td className="text-xs">{describeSchedule(r)}</td>
                    <td className="text-xs">{AUDIENCE_LABELS[r.audience]}</td>
                    <td>{r.offer_discount ? <Badge tone="brand">{r.discount_percent}% off</Badge> : "—"}</td>
                    <td className="tabular-nums">{r.sent}{r.pending ? <span className="text-xs text-muted"> (+{r.pending} queued)</span> : null}</td>
                    <td><Badge tone={r.active ? "ok" : "neutral"}>{r.active ? "active" : "paused"}</Badge></td>
                    <td><ActionForm action={setRuleActiveAction.bind(null, r.id, !r.active)} submitLabel={r.active ? "Pause" : "Activate"} submitClassName="btn-secondary" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-muted">No rules yet. Create the first one below, e.g. a check-in email 30 days after a purchase.</p>}
      </Section>
      <Section title="New reminder rule">
        <ActionForm action={createRuleAction} submitLabel="Create rule" resetOnSuccess>
          <RuleFields {...options} d={{ subject: "How is it going with {{product}}?", body: DEFAULT_BODY }} />
        </ActionForm>
      </Section>
      <Section title="Recent reminder emails">
        {recent.length ? (
          <table className="table">
            <thead><tr><th>Created</th><th>Rule</th><th>Recipient</th><th>Subject</th><th>Status</th></tr></thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDateTime(e.created_at, user.timezone)}</td>
                  <td>{e.rule ?? "—"}</td>
                  <td>{e.recipient ?? e.to_email}</td>
                  <td className="max-w-xs truncate">{e.subject}</td>
                  <td><Badge tone={TONE[e.status as keyof typeof TONE] ?? "neutral"}>{e.status}</Badge>{e.last_error && <div className="max-w-xs text-xs text-muted">{e.last_error}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-muted">No reminder emails yet. Rules run daily with the follow-up job, or now with “Run rules now”.</p>}
      </Section>
    </Page>
  );
}

const DEFAULT_BODY = `Hello {{first_name}},

We wanted to check that everything is going well with {{product}}.
If you have any questions, reply to this email or ask the Vet Companion: {{app_url}}

The BioChange team`;
