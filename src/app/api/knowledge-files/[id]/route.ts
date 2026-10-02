import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { readFile, signedUrl } from "@/lib/storage";
import { getSource } from "@/server/knowledge/sources";
import { isUuid } from "@/server/domain/cases";

/** Uploaded knowledge documents: staff see all; others only approved sources. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let s;
  try {
    s = await getSource(actorFromSession(user), id);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!s.storage_path) return NextResponse.json({ error: "No file" }, { status: 404 });
  const url = await signedUrl(s.storage_path);
  if (url) return NextResponse.redirect(url);
  const data = await readFile(s.storage_path);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": s.mime_type ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${(s.file_name ?? "document").replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
