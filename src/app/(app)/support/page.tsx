import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { listMyRequests } from "@/server/domain/escalations";
import { askMedicalSupportAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function SupportPage() {
  const user = await requireUser();
  const requests = await listMyRequests(actorFromSession(user));
  return (
    <Page>
      <PageHeader title="Medical Support" subtitle="Questions answered by the BioChange medical team when approved information is not enough." />
      <Section title="Your questions">
        {requests.length ? (
          <ul className="divide-y divide-line">
            {requests.map((r) => (
              <li key={r.id} className="py-3">
                <Link href={`/support/${r.id}`} className="flex items-start justify-between gap-3 hover:text-brand">
                  <span className="text-sm">{r.question}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted">{fmtDate(r.created_at)} <Badge tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Badge></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No questions yet. The companion offers to escalate when it lacks approved information.</p>
        )}
      </Section>
      <Section title="Ask Medical Support directly">
        <ActionForm action={askMedicalSupportAction} submitLabel="Send question" resetOnSuccess>
          <div className="space-y-3">
            <textarea name="question" required rows={3} className="input" placeholder="Your question" />
            <div className="flex gap-2">
              <select name="product" className="input w-44"><option value="">Product (optional)</option><option>ReGum Vet</option><option>MicroFoam</option></select>
              <select name="urgency" className="input w-36"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select>
            </div>
          </div>
        </ActionForm>
      </Section>
    </Page>
  );
}
