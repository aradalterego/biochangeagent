import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { sql } from "@/lib/db";
import { readFile, signedUrl } from "@/lib/storage";
import { getCaseRow, isUuid } from "@/server/domain/cases";

/** Case files are private: permission is checked on every access. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [f] = await sql<{ case_id: string; storage_path: string; mime_type: string; file_name: string }[]>`
    SELECT case_id, storage_path, mime_type, file_name FROM case_files WHERE id = ${id}`;
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await getCaseRow(actorFromSession(user), f.case_id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const url = await signedUrl(f.storage_path);
  if (url) return NextResponse.redirect(url);
  const data = await readFile(f.storage_path);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": f.mime_type,
      "Content-Disposition": `inline; filename="${f.file_name.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Uploaded documents must never run script in the app origin.
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
