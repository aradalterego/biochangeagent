import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PKCE_COOKIE, googleAuthorizeUrl, googleEnabled, newPkce } from "@/lib/auth/identity";
import { env } from "@/lib/env";

/** Starts Google sign-in (Supabase OAuth with PKCE). The verifier stays in an httpOnly cookie. */
export async function GET() {
  if (!googleEnabled()) return NextResponse.redirect(new URL("/login", env().APP_URL));
  const { verifier, challenge } = newPkce();
  (await cookies()).set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/auth",
    maxAge: 600,
  });
  return NextResponse.redirect(googleAuthorizeUrl(challenge));
}
