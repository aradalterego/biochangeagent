import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { isBioChangeStaff } from "@/lib/roles";
import { readFile, signedUrl } from "@/lib/storage";
import { isUuid } from "@/server/domain/cases";

/**
 * Marketing materials: any signed-in user can download a published material (staff also hidden ones).
 * Always served as a download, never rendered in the app origin. Each download is counted for reports.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [m] = await sql<{ storage_path: string; mime_type: string; file_name: string; active: boolean }[]>`
    SELECT storage_path, mime_type, file_name, active FROM marketing_materials WHERE id = ${id}`;
  if (!m || (!m.active && !isBioChangeStaff(user.role))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await sql`INSERT INTO marketing_downloads (material_id, user_id) VALUES (${id}, ${user.id})`;
  const safeName = m.file_name.replace(/[^\w.\- ]/g, "_");
  const url = await signedUrl(m.storage_path, 120, safeName);
  if (url) return NextResponse.redirect(url);
  const data = await readFile(m.storage_path);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": m.mime_type,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
