import { requireUser } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { Sidebar } from "@/components/Sidebar";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const conversations = await sql<{ id: string; title: string | null }[]>`
    SELECT id, title FROM conversations WHERE user_id = ${user.id} ORDER BY last_message_at DESC LIMIT 12`;
  return (
    <div className="flex h-screen">
      <Sidebar user={user} conversations={conversations} />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
