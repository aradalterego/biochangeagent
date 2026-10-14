import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { PKCE_COOKIE, exchangeGoogleCode, googleEnabled } from "@/lib/auth/identity";
import { completeSignIn } from "@/lib/auth/signin";
import { clientIp, createSession, requiresMfa } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

/** Google OAuth return. The code is bound to this browser by the PKCE verifier cookie. */
export async function GET(req: Request) {
  const base = env().APP_URL;
  const fail = (reason: string) => NextResponse.redirect(new URL(`/login?error=${reason}`, base));
  if (!googleEnabled()) return fail("google");
  const code = new URL(req.url).searchParams.get("code");
  const jar = await cookies();
  const verifier = jar.get(PKCE_COOKIE)?.value;
  jar.delete({ name: PKCE_COOKIE, path: "/auth" });
  if (!code || !verifier) return fail("google");
  try {
    const identity = await exchangeGoogleCode(code, verifier);
    const result = await completeSignIn(identity, clientIp(await headers()));
    if (!result.ok) return fail("not_invited");
    await createSession(result.userId, { mfaVerified: false });
    return NextResponse.redirect(new URL(requiresMfa(result.role) ? "/login/mfa" : "/", base));
  } catch (err) {
    log.error("auth.google_callback_failed", { err });
    return fail("google");
  }
}
