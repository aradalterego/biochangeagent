import { requireUser } from "@/lib/auth/session";
import { ChatClient } from "@/components/chat/ChatClient";
import { ContextPanel } from "@/components/chat/ContextPanel";
import { loadConversation } from "@/components/chat/loadChat";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { conv, messages, orderStatuses } = await loadConversation(user, id);
  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1">
        <ChatClient key={conv.id} conversationId={conv.id} initialMessages={messages} orderStatuses={orderStatuses} userFirstName={user.name} />
      </div>
      <ContextPanel user={user} activeCaseId={conv.active_case_id} messages={messages} />
    </div>
  );
}
