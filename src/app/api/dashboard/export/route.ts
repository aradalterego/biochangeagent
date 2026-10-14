import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { actorFromSession, AuthorizationError } from "@/lib/authz";
import { hit } from "@/lib/rateLimit";
import { exportCasesCsv, filtersFromParams } from "@/server/domain/dashboard";

/** CSV export of the filtered dashboard cases (BioChange staff only, rate-limited, audited). */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(await hit(`export:${user.id}`, 10, 3600))) return NextResponse.json({ error: "Export limit reached. Try again later." }, { status: 429 });
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  try {
    const { csv } = await exportCasesCsv(actorFromSession(user), filtersFromParams(params));
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="biochange-cases-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof AuthorizationError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw err;
  }
}
