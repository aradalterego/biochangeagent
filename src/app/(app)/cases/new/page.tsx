import { requireRole } from "@/lib/auth/session";
import { listProducts } from "@/server/domain/products";
import { createCaseAction } from "@/app/actions/cases";
import { ActionForm } from "@/components/ActionForm";
import { CaseFields } from "@/components/CaseFields";
import { Page, PageHeader } from "@/components/ui";

export default async function NewCasePage() {
  await requireRole(["veterinarian", "clinic_admin"]);
  const products = await listProducts();
  return (
    <Page>
      <PageHeader title="New case" subtitle="Only clinical information needed for follow-up. Do not enter owner details." />
      <div className="card p-6">
        <ActionForm action={createCaseAction} submitLabel="Save case">
          <CaseFields products={products} />
        </ActionForm>
      </div>
    </Page>
  );
}
