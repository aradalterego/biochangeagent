import { requireRole } from "@/lib/auth/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole(["biochange_admin", "biochange_medical"]);
  return children;
}
