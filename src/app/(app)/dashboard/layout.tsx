import { requireRole } from "@/lib/auth/session";

/** Internal clinical dashboard: BioChange staff only (each query re-checks the role server-side). */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireRole(["biochange_admin", "biochange_medical"]);
  return children;
}
