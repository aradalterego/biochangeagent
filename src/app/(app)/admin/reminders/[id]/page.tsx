import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { deleteRuleAction, updateRuleAction } from "@/app/actions/engagement";
import { ActionForm } from "@/components/ActionForm";
import { RuleFields } from "@/components/RuleFields";
import { Page, PageHeader, Section } from "@/components/ui";
import { isoDate } from "@/lib/format";
import { describeSchedule, getRule } from "@/server/domain/engagement";
import { ruleFormOptions } from "@/server/domain/engagementOptions";

export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(["biochange_admin"]);
  const { id } = await params;
  const [rule, options] = await Promise.all([getRule(id), ruleFormOptions()]);
  if (!rule) notFound();
  return (
    <Page wide>
      <PageHeader title={rule.name} subtitle={describeSchedule(rule)} />
      <Section title="Edit rule">
        <ActionForm action={updateRuleAction.bind(null, rule.id)} submitLabel="Save rule">
          <RuleFields {...options} d={{ ...rule, applies_from: isoDate(rule.applies_from) }} />
        </ActionForm>
        <p className="mt-2 text-xs text-muted">Changes apply to emails not sent yet. An email already sent for an event is never sent again.</p>
      </Section>
      <Section title="Delete">
        <ActionForm action={deleteRuleAction.bind(null, rule.id)} submitLabel="Delete rule" submitClassName="btn-danger" confirm="Delete this rule? Sent emails stay in the log." />
      </Section>
    </Page>
  );
}
