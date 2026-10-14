import "server-only";
import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { env, isProductionLike } from "@/lib/env";
import { randomToken, sha256 } from "@/lib/crypto";
import { sendEmail } from "@/lib/email";
import { log } from "@/lib/log";

/**
 * Identity verification for passwordless sign-in. The provider only proves who the person
 * is (a verified email address); the application then maps that identity to an invited
 * user in `users` and issues its own server-side session. Authorization never depends on
 * the provider.
 *
 *   supabase — Supabase Auth: magic link (email OTP, token_hash flow) and Google OAuth (PKCE).
 *   dev      — local one-time links stored in `auth_tokens`; refused outside development.
 */

export interface VerifiedIdentity {
  provider: "supabase" | "dev";
  subject: string;
  email: string;
  method: "magic_link" | "google";
}

export class IdentityError extends Error {
  constructor(message = "The sign-in link is invalid or has expired.") {
    super(message);
    this.name = "IdentityError";
  }
}

const LINK_TTL_MINUTES = 15;

/** httpOnly cookie that binds a Google sign-in to the browser that started it. */
export const PKCE_COOKIE = "bc_pkce";

export function confirmUrl(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/auth/confirm`;
}

export function callbackUrl(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/auth/callback`;
}

// ---------------------------------------------------------------------------
// Magic link
// ---------------------------------------------------------------------------

export async function sendSignInLink(email: string): Promise<void> {
  if (env().AUTH_PROVIDER === "supabase") {
    const res = await supabaseFetch(`/otp?redirect_to=${encodeURIComponent(confirmUrl())}`, { email, create_user: true });
    if (!res.ok) throw new Error(`Identity provider refused the sign-in link (${res.status}).`);
    return;
  }
  assertDevAllowed();
  const token = randomToken();
  await sql`INSERT INTO auth_tokens (token_hash, email, expires_at)
            VALUES (${sha256(token)}, ${email}, now() + make_interval(mins => ${LINK_TTL_MINUTES}))`;
  await sendEmail({
    to: email,
    subject: "Your BioChange sign-in link",
    text: `Use this link to sign in. It works once and expires in ${LINK_TTL_MINUTES} minutes.\n\n${confirmUrl()}?token=${token}\n\nIf you did not ask for it, ignore this email.`,
  });
}

/** Consumes a sign-in link (one-time). `params` are the query parameters of /auth/confirm. */
export async function verifySignInLink(params: { token?: string | null; tokenHash?: string | null; type?: string | null }): Promise<VerifiedIdentity> {
  if (env().AUTH_PROVIDER === "supabase") {
    if (!params.tokenHash) throw new IdentityError();
    const type = params.type === "magiclink" ? "magiclink" : "email";
    const res = await supabaseFetch("/verify", { type, token_hash: params.tokenHash });
    if (!res.ok) throw new IdentityError();
    return identityFromSupabase(await res.json(), "magic_link");
  }
  assertDevAllowed();
  if (!params.token) throw new IdentityError();
  const [row] = await sql<{ id: string; email: string }[]>`
    UPDATE auth_tokens SET used_at = now()
    WHERE token_hash = ${sha256(params.token)} AND used_at IS NULL AND expires_at > now()
    RETURNING id, email`;
  if (!row) throw new IdentityError();
  return { provider: "dev", subject: `email:${row.email.toLowerCase()}`, email: row.email.toLowerCase(), method: "magic_link" };
}

// ---------------------------------------------------------------------------
// Google (via Supabase OAuth, PKCE)
// ---------------------------------------------------------------------------

export function googleEnabled(): boolean {
  const e = env();
  return e.AUTH_PROVIDER === "supabase" && e.AUTH_GOOGLE_ENABLED;
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function googleAuthorizeUrl(challenge: string): string {
  const base = supabaseAuthBase();
  const q = new URLSearchParams({ provider: "google", redirect_to: callbackUrl(), code_challenge: challenge, code_challenge_method: "s256" });
  return `${base}/authorize?${q}`;
}

export async function exchangeGoogleCode(code: string, verifier: string): Promise<VerifiedIdentity> {
  const res = await supabaseFetch("/token?grant_type=pkce", { auth_code: code, code_verifier: verifier });
  if (!res.ok) throw new IdentityError("Google sign-in could not be completed.");
  return identityFromSupabase(await res.json(), "google");
}

// ---------------------------------------------------------------------------

async function identityFromSupabase(body: unknown, method: VerifiedIdentity["method"]): Promise<VerifiedIdentity> {
  const b = body as { access_token?: string; user?: { id?: string; email?: string; email_confirmed_at?: string | null } };
  const u = b.user;
  if (!u?.id || !u.email || !u.email_confirmed_at) throw new IdentityError("The identity provider did not return a verified email address.");
  // The provider session is not used by this app; end it right away.
  if (b.access_token) {
    await fetch(`${supabaseAuthBase()}/logout`, { method: "POST", headers: { apikey: anonKey(), Authorization: `Bearer ${b.access_token}` } })
      .catch((err) => log.warn("auth.provider_logout_failed", { err }));
  }
  return { provider: "supabase", subject: u.id, email: u.email.toLowerCase(), method };
}

function supabaseAuthBase(): string {
  const url = env().SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is required when AUTH_PROVIDER=supabase");
  return `${url.replace(/\/$/, "")}/auth/v1`;
}

function anonKey(): string {
  const k = env().SUPABASE_ANON_KEY;
  if (!k) throw new Error("SUPABASE_ANON_KEY is required when AUTH_PROVIDER=supabase");
  return k;
}

function supabaseFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${supabaseAuthBase()}${path}`, {
    method: "POST",
    headers: { apikey: anonKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

function assertDevAllowed() {
  if (isProductionLike()) throw new Error("AUTH_PROVIDER=dev is not allowed outside development.");
}
