import "server-only";
import { sql } from "@/lib/db";

export interface MarketingMaterial {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  product: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  active: boolean;
  sort_order: number;
  downloads: number;
  created_at: Date;
}

/** Published materials for veterinarians, or every material (with download counts) for Admin. */
export async function listMarketingMaterials(opts: { includeHidden?: boolean } = {}): Promise<MarketingMaterial[]> {
  return sql<MarketingMaterial[]>`
    SELECT m.id, m.title, m.description, m.category, p.product_family AS product, m.file_name, m.mime_type, m.size_bytes, m.active, m.sort_order, m.created_at,
      (SELECT count(*)::int FROM marketing_downloads d WHERE d.material_id = m.id) AS downloads
    FROM marketing_materials m LEFT JOIN products p ON p.id = m.product_id
    WHERE ${opts.includeHidden ? sql`true` : sql`m.active`}
    ORDER BY m.sort_order, p.product_family NULLS FIRST, m.title`;
}

export function fileLabel(mime: string, size: number): string {
  const type = ({
    "application/pdf": "PDF", "image/png": "PNG", "image/jpeg": "JPG", "image/webp": "WebP", "video/mp4": "Video", "application/zip": "ZIP",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  } as Record<string, string>)[mime] ?? "File";
  const mb = size / 1024 / 1024;
  return `${type} · ${mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`}`;
}
