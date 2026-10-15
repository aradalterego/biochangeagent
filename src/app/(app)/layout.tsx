import { requireUser } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { Sidebar } from "@/components/Sidebar";
import { DemoBanner } from "@/components/DemoBanner";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const conversations = await sql<{ id: string; title: string | null }[]>`
    SELECT id, title FROM conversations WHERE user_id = ${user.id} ORDER BY last_message_at DESC LIMIT 12`;
  return (
    <div className="flex h-screen flex-col">
      <DemoBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar user={user} conversations={conversations} />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
