import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { env, isDemoEnvironment, isProductionLike } from "@/lib/env";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness for uptime monitoring. Reports pass/fail per check only — no versions,
 * hostnames, counts or configuration values.
 */
export async function GET() {
  const checks: Record<string, "ok" | "fail"> = {};
  try {
    env();
    checks.config = "ok";
  } catch (err) {
    log.error("health.config_invalid", { err });
    checks.config = "fail";
  }
  try {
    await sql`SELECT 1`;
    checks.database = "ok";
    if (isProductionLike() && !isDemoEnvironment()) {
      // Production must not contain demo accounts or demo knowledge used in answers.
      const [{ demo }] = await sql<{ demo: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM users WHERE email LIKE '%@demo.biochange.test' AND active)
            OR EXISTS (SELECT 1 FROM knowledge_sources WHERE status = 'approved' AND 'demo-mock' = ANY(tags)) AS demo`;
      checks.no_demo_data = demo ? "fail" : "ok";
    }
  } catch (err) {
    log.error("health.database_failed", { err });
    checks.database = "fail";
  }
  const ok = Object.values(checks).every((c) => c === "ok");
  return NextResponse.json({ status: ok ? "ok" : "fail", checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
