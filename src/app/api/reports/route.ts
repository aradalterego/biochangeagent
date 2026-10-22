import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { actorFromSession, AuthorizationError } from "@/lib/authz";
import { hit } from "@/lib/rateLimit";
import { REPORT_TYPES, buildReport, type ReportType } from "@/server/domain/reports";

/** CSV reports (BioChange staff only, rate-limited, audited). ?type=cases|vets|offers|downloads|emails plus filters. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const type = params.type as ReportType;
  if (!REPORT_TYPES.includes(type)) return NextResponse.json({ error: "Unknown report" }, { status: 400 });
  if (!(await hit(`export:${user.id}`, 30, 3600))) return NextResponse.json({ error: "Export limit reached. Try again later." }, { status: 429 });
  try {
    const { csv } = await buildReport(actorFromSession(user), type, params);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="biochange-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof AuthorizationError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw err;
  }
}
