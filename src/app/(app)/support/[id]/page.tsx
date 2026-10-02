import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { sql } from "@/lib/db";
import { markAnswerSeen } from "@/server/domain/escalations";
import { isUuid } from "@/server/domain/cases";
import { Badge, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function SupportRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [r] = await sql<{ id: string; question: string; status: string; answer: string | null; answered_at: Date | null; created_at: Date; urgency: string }[]>`
    SELECT id, question, status, answer, answered_at, created_at, urgency FROM medical_support_requests WHERE id = ${id} AND user_id = ${user.id}`;
  if (!r) notFound();
  // Only a released answer is shown; drafts saved while 'in review' stay internal.
  const released = r.status === "answered" || r.status === "closed";
  const answer = released ? r.answer : null;
  if (answer) await markAnswerSeen(actorFromSession(user), id);
  return (
    <Page>
      <PageHeader title="Medical Support request" subtitle={<span className="flex items-center gap-2">Sent {fmtDateTime(r.created_at, user.timezone)} <Badge tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Badge></span>} />
      <Section title="Question"><p className="whitespace-pre-wrap text-sm">{r.question}</p></Section>
      <Section title="Answer">
        {answer ? (
          <>
            <p className="whitespace-pre-wrap text-sm">{answer}</p>
            <p className="mt-2 text-xs text-muted">Answered {fmtDateTime(r.answered_at, user.timezone)} by BioChange Medical Support.</p>
          </>
        ) : (
          <p className="text-sm text-muted">Not answered yet. You&apos;ll see it on your Today page when it is.</p>
        )}
      </Section>
    </Page>
  );
}
