import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { runFollowUpReminders } from "@/server/domain/followUpReminders";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily follow-up reminders (Vercel Cron, see vercel.json). Requires "Authorization: Bearer CRON_SECRET". */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runFollowUpReminders();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    log.error("cron.follow_ups_failed", { err });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
