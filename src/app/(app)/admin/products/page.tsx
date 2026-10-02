import { requireRole } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { saveProductAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import type { Product } from "@/server/domain/products";

export default async function ProductsPage() {
  await requireRole(["biochange_admin"]);
  const products = await sql<Product[]>`SELECT * FROM products ORDER BY product_family, variant NULLS FIRST`;
  const form = (p?: Product) => (
    <ActionForm action={saveProductAction} submitLabel={p ? "Save" : "Add product / variant"} resetOnSuccess={!p}>
      {p && <input type="hidden" name="id" value={p.id} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <div><label className="label">Name</label><input name="name" required defaultValue={p?.name} className="input" /></div>
        <div><label className="label">Family</label><select name="product_family" defaultValue={p?.product_family ?? "ReGum Vet"} className="input"><option>ReGum Vet</option><option>MicroFoam</option></select></div>
        <div><label className="label">Variant (size / shape)</label><input name="variant" defaultValue={p?.variant ?? ""} className="input" /></div>
        <div><label className="label">SKU</label><input name="sku" required defaultValue={p?.sku} className="input" /></div>
        <div><label className="label">Form</label><input name="form" defaultValue={p?.form ?? ""} className="input" /></div>
        <div><label className="label">Units per package</label><input name="units_per_package" type="number" min={1} defaultValue={p?.units_per_package ?? 1} className="input" /></div>
        <div><label className="label">Market</label><input name="market" defaultValue={p?.market ?? "global"} className="input" /></div>
        <div className="flex items-end gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="checkbox" name="active" defaultChecked={p?.active ?? true} /> Active</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" name="is_placeholder_sku" defaultChecked={p?.is_placeholder_sku ?? false} /> Placeholder SKU</label>
        </div>
      </div>
    </ActionForm>
  );
  return (
    <Page wide>
      <PageHeader title="Products" subtitle="Product families, configuration/size variants, SKUs and package quantities used for inventory and ordering." />
      {products.map((p) => (
        <Section key={p.id} title={`${p.name}${p.variant ? ` — ${p.variant}` : ""}`} actions={<span className="flex gap-1">{p.is_placeholder_sku && <Badge tone="warn">placeholder SKU</Badge>}{!p.active && <Badge>inactive</Badge>}</span>}>
          {form(p)}
        </Section>
      ))}
      <Section title="Add product or variant">{form()}</Section>
    </Page>
  );
}
