import "server-only";
import { sql } from "@/lib/db";
import { isDemoEnvironment, isProductionLike } from "@/lib/env";
import { audit } from "@/lib/audit";
import { hit } from "@/lib/rateLimit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { log } from "@/lib/log";
import type { Role } from "@/lib/roles";
import { sendSignInLink, type VerifiedIdentity } from "./identity";
import { generateTotpSecret, verifyTotp } from "./totp";

/**
 * Sign-in policy (independent of cookies so it can be tested directly):
 *   - invite-only: an identity is accepted only for an existing, active user
 *   - an account bound to one provider subject cannot be taken over by another subject
 *   - demo accounts are refused in production
 *   - every success and failure is audited (without secrets)
 */

const DEMO_DOMAIN = "@demo.biochange.test";

export function isDemoAccount(email: string): boolean {
  return email.toLowerCase().endsWith(DEMO_DOMAIN);
}

function demoRefused(email: string): boolean {
  return isDemoAccount(email) && isProductionLike() && !isDemoEnvironment();
}

/**
 * Sends a sign-in link if (and only if) the email belongs to an active, invited user.
 * The caller always shows the same neutral message, so this does not reveal who is registered.
 */
export async function requestSignInLink(rawEmail: string, ip: string | null): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return;
  const okEmail = await hit(`signin-link:email:${email}`, 5, 15 * 60);
  const okIp = ip ? await hit(`signin-link:ip:${ip}`, 30, 15 * 60) : true;
  if (!okEmail || !okIp) {
    log.warn("auth.link_rate_limited");
    return;
  }
  const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND active`;
  if (!u || demoRefused(email)) return;
  await sendSignInLink(email);
  await audit({ userId: u.id, role: "veterinarian", clinicId: null }, { action: "auth.link_requested", entityType: "user", entityId: u.id, tool: "ui" });
}

export type SignInResult = { ok: true; userId: string; role: Role } | { ok: false; reason: "not_invited" | "identity_mismatch" };

/** Maps a verified identity to an invited user. */
export async function completeSignIn(identity: VerifiedIdentity, ip: string | null): Promise<SignInResult> {
  const [u] = await sql<{ id: string; role: Role; active: boolean; auth_provider: string | null; auth_subject: string | null; email: string }[]>`
    SELECT id, role, active, auth_provider, auth_subject, email FROM users WHERE email = ${identity.email}`;
  if (!u || !u.active || demoRefused(u.email)) {
    await recordFailure(identity.email, ip, u?.id ?? null, `not_invited (${identity.method})`);
    return { ok: false, reason: "not_invited" };
  }
  if (u.auth_subject && u.auth_provider === identity.provider && u.auth_subject !== identity.subject) {
    await recordFailure(identity.email, ip, u.id, `identity_mismatch (${identity.method})`);
    return { ok: false, reason: "identity_mismatch" };
  }
  await sql`UPDATE users SET auth_provider = coalesce(auth_provider, ${identity.provider}),
              auth_subject = CASE WHEN auth_provider IS NULL OR auth_provider = ${identity.provider} THEN coalesce(auth_subject, ${identity.subject}) ELSE auth_subject END,
              last_login_at = now()
            WHERE id = ${u.id}`;
  await sql`INSERT INTO login_attempts (email, ip, success) VALUES (${identity.email}, ${ip}, true)`;
  await audit({ userId: u.id, role: u.role, clinicId: null }, { action: "auth.login", entityType: "user", entityId: u.id, tool: "ui", inputSummary: identity.method });
  return { ok: true, userId: u.id, role: u.role };
}

export async function recordFailure(email: string, ip: string | null, userId: string | null, reason: string): Promise<void> {
  await sql`INSERT INTO login_attempts (email, ip, success) VALUES (${email}, ${ip}, false)`;
  await sql`INSERT INTO audit_log (user_id, action, entity_type, entity_id, tool, input_summary, result)
            VALUES (${userId}, 'auth.login_failed', 'user', ${userId}, 'ui', ${reason}, 'denied')`;
}

// ---------------------------------------------------------------------------
// TOTP MFA for BioChange staff
// ---------------------------------------------------------------------------

export interface MfaState {
  enrolled: boolean;
  /** Present only while enrolling, so the authenticator app can be set up. */
  pendingSecret: string | null;
}

/** Returns enrollment state, creating a pending secret when the user has none yet. */
export async function getOrStartMfaEnrollment(userId: string): Promise<MfaState> {
  const [u] = await sql<{ totp_secret_enc: string | null; totp_enabled_at: Date | null }[]>`
    SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = ${userId}`;
  if (u?.totp_enabled_at) return { enrolled: true, pendingSecret: null };
  if (u?.totp_secret_enc) return { enrolled: false, pendingSecret: decryptSecret(u.totp_secret_enc) };
  const secret = generateTotpSecret();
  await sql`UPDATE users SET totp_secret_enc = ${encryptSecret(secret)} WHERE id = ${userId} AND totp_enabled_at IS NULL`;
  return { enrolled: false, pendingSecret: secret };
}

/** Verifies a TOTP code (completing enrollment if needed). A code is accepted at most once. */
export async function verifyMfaCode(userId: string, code: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [u] = await tx<{ totp_secret_enc: string | null; totp_enabled_at: Date | null; totp_last_step: string | null; role: Role }[]>`
      SELECT totp_secret_enc, totp_enabled_at, totp_last_step, role FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!u?.totp_secret_enc) return false;
    const step = verifyTotp(decryptSecret(u.totp_secret_enc), code, { lastStep: u.totp_last_step == null ? null : Number(u.totp_last_step) });
    const actor = { userId, role: u.role, clinicId: null };
    if (step == null) {
      await audit(actor, { action: "auth.mfa_failed", entityType: "user", entityId: userId, tool: "ui", result: "denied" }, tx);
      return false;
    }
    await tx`UPDATE users SET totp_last_step = ${step}, totp_enabled_at = coalesce(totp_enabled_at, now()) WHERE id = ${userId}`;
    await audit(actor, { action: u.totp_enabled_at ? "auth.mfa_verified" : "auth.mfa_enrolled", entityType: "user", entityId: userId, tool: "ui" }, tx);
    return true;
  });
}
