import Link from "next/link";
import { Logo } from "./Logo";
import { NavLink } from "./NavLink";
import { logoutAction } from "@/app/actions/auth";
import type { SessionUser } from "@/lib/auth/session";
import { ROLE_LABELS, isBioChangeStaff, isClinicRole } from "@/lib/roles";

export function Sidebar({ user, conversations }: { user: SessionUser; conversations: { id: string; title: string | null }[] }) {
  const clinic = isClinicRole(user.role);
  const staff = isBioChangeStaff(user.role);
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-white">
      <div className="flex items-center gap-2 px-4 py-4">
        <Logo />
        <div className="leading-tight">
          <div className="text-sm font-semibold">BioChange</div>
          <div className="text-xs text-muted">Vet Companion</div>
        </div>
      </div>
      <div className="px-3">
        <Link href="/chat" className="btn-primary w-full">+ New conversation</Link>
      </div>
      <nav className="mt-4 flex-1 overflow-y-auto px-3 text-sm">
        <NavLink href="/">Today</NavLink>
        {clinic && (
          <>
            <NavLink href="/cases">Cases</NavLink>
            <NavLink href="/inventory">Inventory</NavLink>
            <NavLink href="/orders">Orders</NavLink>
          </>
        )}
        <NavLink href="/education">Education</NavLink>
        <NavLink href="/support">Medical Support</NavLink>
        <NavLink href="/profile">Profile &amp; memory</NavLink>
        {staff && (
          <>
            <div className="mt-5 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Admin</div>
            <NavLink href="/admin/knowledge">Knowledge Sources</NavLink>
            <NavLink href="/admin/claims">Approved Claims</NavLink>
            <NavLink href="/admin/gaps">Knowledge Gaps</NavLink>
            <NavLink href="/admin/escalations">Escalations</NavLink>
            {user.role === "biochange_admin" && (
              <>
                <NavLink href="/admin/accounts">Users &amp; Clinics</NavLink>
                <NavLink href="/admin/products">Products</NavLink>
                <NavLink href="/admin/analytics">Analytics</NavLink>
                <NavLink href="/admin/audit">Audit Log</NavLink>
              </>
            )}
          </>
        )}
        {conversations.length > 0 && (
          <>
            <div className="mt-5 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Recent conversations</div>
            {conversations.map((c) => (
              <NavLink key={c.id} href={`/chat/${c.id}`} subtle>
                {c.title || "Conversation"}
              </NavLink>
            ))}
          </>
        )}
      </nav>
      <div className="border-t border-line px-4 py-3 text-xs">
        <div className="font-medium text-ink">{user.name}</div>
        <div className="text-muted">{ROLE_LABELS[user.role]}</div>
        <form action={logoutAction}>
          <button className="mt-2 text-brand hover:underline">Sign out</button>
        </form>
      </div>
    </aside>
  );
}
