import { fileLabel, listMarketingMaterials } from "@/server/domain/marketing";

/** Small box next to the chat: marketing materials the veterinarian can download in one click. */
export async function MarketingBox() {
  const materials = await listMarketingMaterials();
  return (
    <div className="rounded-lg border border-line bg-canvas/50 p-3">
      <div className="mb-1.5 text-xs font-semibold text-muted">Marketing materials</div>
      {materials.length ? (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {materials.map((m) => (
            <li key={m.id}>
              <a href={`/api/marketing-files/${m.id}`} download className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-white" title={m.description ?? m.title}>
                <span aria-hidden className="mt-0.5 text-brand">↓</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink group-hover:text-brand">{m.title}</span>
                  <span className="block text-[11px] text-muted">{[m.product, fileLabel(m.mime_type, m.size_bytes)].filter(Boolean).join(" · ")}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">No materials yet.</p>
      )}
    </div>
  );
}
