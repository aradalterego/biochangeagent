import { requireRole } from "@/lib/auth/session";
import { TabNav } from "@/components/TabNav";

const TABS = [
  { href: "/admin/reminders", label: "Reminder rules" },
  { href: "/admin/reminders/compose", label: "Write email" },
  { href: "/admin/reminders/templates", label: "Templates" },
  { href: "/admin/reminders/events", label: "Trigger events" },
  { href: "/admin/reminders/offers", label: "Feedback & discounts" },
];

export default async function RemindersLayout({ children }: { children: React.ReactNode }) {
  await requireRole(["biochange_admin"]);
  return (
    <>
      <div className="mx-auto max-w-7xl px-6 pt-6">
        <TabNav tabs={TABS} />
      </div>
      {children}
    </>
  );
}
