import { requireRole } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { deleteMarketingAction, setMarketingActiveAction, uploadMarketingAction } from "@/app/actions/engagement";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { fileLabel, listMarketingMaterials } from "@/server/domain/marketing";

/** Marketing materials: uploaded here, downloaded by veterinarians from the box next to the chat. */
export default async function MarketingAdminPage() {
  await requireRole(["biochange_admin"]);
  const [materials, products] = await Promise.all([
    listMarketingMaterials({ includeHidden: true }),
    sql<{ id: string; name: string }[]>`SELECT id, name FROM products WHERE active ORDER BY name`,
  ]);
  return (
    <Page wide>
      <PageHeader title="Marketing materials" subtitle="Brochures, images, presentations and videos that veterinarians download in one click next to the chat." />
      <div className="grid gap-5 lg:grid-cols-3">
        <Section title="Upload material">
          <ActionForm action={uploadMarketingAction} submitLabel="Upload" resetOnSuccess>
            <div className="space-y-3">
              <div><label className="label">Title</label><input name="title" required maxLength={200} className="input" placeholder="e.g. ReGum Vet clinic brochure" /></div>
              <div><label className="label">Description</label><input name="description" maxLength={500} className="input" /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className="label">Product</label><select name="product_id" className="input" defaultValue=""><option value="">General</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                <div><label className="label">Category</label><input name="category" list="mk-categories" className="input" /><datalist id="mk-categories">{["Brochure", "Social media", "Poster", "Presentation", "Video", "Client handout"].map((c) => <option key={c} value={c} />)}</datalist></div>
              </div>
              <div><label className="label">Order</label><input name="sort_order" type="number" defaultValue={0} className="input" /></div>
              <div><label className="label">File</label><input name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.pptx,.docx,.xlsx,.mp4,.zip" className="input" /></div>
            </div>
          </ActionForm>
          <p className="mt-3 text-xs text-muted">PDF, PNG, JPG, WebP, PowerPoint, Word, Excel (without macros), MP4 or ZIP, up to 20 MB. Files are always downloaded, never opened in the app.</p>
        </Section>
        <div className="lg:col-span-2">
          <Section title={`Materials (${materials.length})`}>
            {materials.length ? (
              <table className="table">
                <thead><tr><th>Material</th><th>Product</th><th>File</th><th>Downloads</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {materials.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <a href={`/api/marketing-files/${m.id}`} className="font-medium text-brand hover:underline">{m.title}</a>
                        <div className="text-xs text-muted">{[m.category, m.description].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td>{m.product ?? "General"}</td>
                      <td className="text-xs">{fileLabel(m.mime_type, m.size_bytes)}<div className="text-muted">{fmtDate(m.created_at)}</div></td>
                      <td className="tabular-nums">{m.downloads}</td>
                      <td><Badge tone={m.active ? "ok" : "neutral"}>{m.active ? "visible" : "hidden"}</Badge></td>
                      <td className="space-y-1">
                        <ActionForm action={setMarketingActiveAction.bind(null, m.id, !m.active)} submitLabel={m.active ? "Hide" : "Show"} submitClassName="btn-secondary" />
                        <ActionForm action={deleteMarketingAction.bind(null, m.id)} submitLabel="Delete" submitClassName="text-xs text-danger hover:underline" confirm={`Delete "${m.title}"?`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-sm text-muted">No materials uploaded yet.</p>}
          </Section>
        </div>
      </div>
    </Page>
  );
}
