import { requireRole } from "@/lib/auth/session";
import { createSourceAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { SourceFields } from "@/components/SourceFields";
import { Page, PageHeader } from "@/components/ui";
import { allowedHosts } from "@/server/knowledge/fetch";

export default async function NewSourcePage() {
  await requireRole(["biochange_admin", "biochange_medical"]);
  return (
    <Page>
      <PageHeader title="Add knowledge source" subtitle="Upload a file or enter an approved URL. The source is parsed and stays PENDING REVIEW until approved." />
      <div className="card p-6">
        <ActionForm action={createSourceAction} submitLabel="Add & parse">
          <div className="mb-5 grid gap-4 rounded-lg bg-canvas p-4 sm:grid-cols-2">
            <div><label className="label">Upload file (PDF, TXT or Markdown, max 25 MB)</label><input type="file" name="file" accept=".pdf,.txt,.md" className="block w-full text-sm" /></div>
            <div className="text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="fetch_url" defaultChecked /> Fetch and parse the Source URL (if no file)</label>
              <p className="mt-1 text-xs text-muted">Allowed hosts: {allowedHosts().join(", ")}</p>
            </div>
          </div>
          <SourceFields />
        </ActionForm>
      </div>
    </Page>
  );
}
