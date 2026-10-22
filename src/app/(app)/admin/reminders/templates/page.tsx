import { requireRole } from "@/lib/auth/session";
import { deleteTemplateAction, saveTemplateAction } from "@/app/actions/engagement";
import { ActionForm } from "@/components/ActionForm";
import { Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { MERGE_TAGS, listTemplates } from "@/server/domain/engagement";

function TemplateFields({ t }: { t?: { name: string; subject: string; body: string } }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Template name</label><input name="name" required defaultValue={t?.name} className="input" /></div>
        <div><label className="label">Subject</label><input name="subject" required maxLength={200} defaultValue={t?.subject} className="input" /></div>
      </div>
      <div><label className="label">Body</label><textarea name="body" required rows={8} defaultValue={t?.body} className="input font-mono text-xs" /></div>
    </div>
  );
}

/** Reusable email templates for written emails and reminder rules. */
export default async function TemplatesPage() {
  await requireRole(["biochange_admin"]);
  const templates = await listTemplates();
  return (
    <Page wide>
      <PageHeader title="Email templates" subtitle="Reusable subject and body for emails and reminder rules." />
      <Section title="New template">
        <ActionForm action={saveTemplateAction.bind(null, null)} submitLabel="Create template" resetOnSuccess>
          <TemplateFields />
          <p className="mt-2 text-xs text-muted">Merge tags: {MERGE_TAGS.map((t) => <code key={t} className="mr-1.5">{`{{${t}}}`}</code>)}. <code>{"{{product}}"}</code>, <code>{"{{feedback_link}}"}</code> and <code>{"{{discount_percent}}"}</code> are filled in reminder-rule emails.</p>
        </ActionForm>
      </Section>
      {templates.map((t) => (
        <Section key={t.id} title={t.name} actions={<span className="text-xs text-muted">Updated {fmtDate(t.updated_at)}</span>}>
          <ActionForm action={saveTemplateAction.bind(null, t.id)} submitLabel="Save template">
            <TemplateFields t={t} />
          </ActionForm>
          <ActionForm action={deleteTemplateAction.bind(null, t.id)} submitLabel="Delete" submitClassName="text-xs text-danger hover:underline" confirm={`Delete the template "${t.name}"?`} />
        </Section>
      ))}
    </Page>
  );
}
