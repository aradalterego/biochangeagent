import { requireUser } from "@/lib/auth/session";
import { ChatClient } from "@/components/chat/ChatClient";
import { ContextPanel } from "@/components/chat/ContextPanel";
import { getCaseRow } from "@/server/domain/cases";
import { actorFromSession } from "@/lib/authz";

const PROMPTS: Record<string, string> = {
  "first-case": "I'm planning my first case with ReGum Vet. What do I need to know?",
};

export default async function NewChatPage({ searchParams }: { searchParams: Promise<{ case?: string; prompt?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const caseRow = sp.case ? await getCaseRow(actorFromSession(user), sp.case).catch(() => null) : null;
  const prompt = sp.prompt ? PROMPTS[sp.prompt] : caseRow ? `About case ${caseRow.tooth ? `tooth ${caseRow.tooth}` : ""}${caseRow.internal_patient_identifier ? ` (${caseRow.internal_patient_identifier})` : ""}: ` : undefined;
  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1">
        <ChatClient conversationId={null} initialMessages={[]} orderStatuses={{}} caseId={caseRow?.id ?? null} initialPrompt={prompt} userFirstName={user.name} />
      </div>
      <ContextPanel user={user} activeCaseId={caseRow?.id ?? null} messages={[]} />
    </div>
  );
}
