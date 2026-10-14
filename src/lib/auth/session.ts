import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { randomToken, sha256 } from "@/lib/crypto";
import { isBioChangeStaff, type Role } from "@/lib/roles";

export const SESSION_COOKIE = "bc_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  clinicId: string | null;
  timezone: string;
  preferredLanguage: string;
  professionalTitle: string | null;
  country: string | null;
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
  mfaVerified: boolean;
}

/** BioChange staff see all clinical data, so a second factor is required (configurable for local dev). */
export function requiresMfa(role: Role): boolean {
  return isBioChangeStaff(role) && env().STAFF_MFA_REQUIRED;
}

function idleMinutes(role: Role): number {
  return isBioChangeStaff(role) ? env().STAFF_SESSION_IDLE_MINUTES : env().SESSION_IDLE_MINUTES;
}

// ---------------------------------------------------------------------------
// Session records (no cookies — usable from tests and scripts)
// ---------------------------------------------------------------------------

/** Creates a session and returns the opaque token. Only its SHA-256 is stored. */
export async function issueSession(userId: string, opts: { mfaVerified: boolean; ip?: string | null; userAgent?: string | null }): Promise<{ token: string; expires: Date }> {
  const token = randomToken();
  const expires = new Date(Date.now() + env().SESSION_TTL_HOURS * 3600_000);
  await sql`
    INSERT INTO sessions (id, user_id, expires_at, ip, user_agent, mfa_verified)
    VALUES (${sha256(token)}, ${userId}, ${expires}, ${opts.ip ?? null}, ${opts.userAgent?.slice(0, 300) ?? null}, ${opts.mfaVerified})`;
  // Housekeeping: expired sessions are useless; remove a few on every sign-in.
  await sql`DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < now() LIMIT 200)`;
  return { token, expires };
}

/** Validates a token: absolute expiry, idle timeout and an active user. Idle sessions are deleted. */
export async function resolveSession(token: string | undefined | null): Promise<ResolvedSession | null> {
  if (!token) return null;
  const rows = await sql<
    {
      sid: string; last_seen_at: Date; mfa_verified: boolean; id: string; email: string; name: string; role: Role; clinic_id: string | null;
      timezone: string; preferred_language: string; professional_title: string | null; country: string | null; last_active_at: Date | null;
    }[]
  >`
    SELECT s.id AS sid, s.last_seen_at, s.mfa_verified, u.id, u.email, u.name, u.role, u.clinic_id, u.timezone, u.preferred_language,
           u.professional_title, u.country, u.last_active_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sha256(token)} AND s.expires_at > now() AND u.active`;
  const u = rows[0];
  if (!u) return null;
  if (Date.now() - u.last_seen_at.getTime() > idleMinutes(u.role) * 60_000) {
    await sql`DELETE FROM sessions WHERE id = ${u.sid}`;
    return null;
  }
  if (Date.now() - u.last_seen_at.getTime() > 60_000) await sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${u.sid}`;
  if (!u.last_active_at || Date.now() - u.last_active_at.getTime() > 5 * 60_000) {
    await sql`UPDATE users SET last_active_at = now() WHERE id = ${u.id}`;
  }
  return {
    sessionId: u.sid,
    mfaVerified: u.mfa_verified,
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      clinicId: u.clinic_id,
      timezone: u.timezone,
      preferredLanguage: u.preferred_language,
      professionalTitle: u.professional_title,
      country: u.country,
    },
  };
}

/** A session is fully authenticated when it does not still owe a second factor. */
export function isFullyAuthenticated(s: ResolvedSession): boolean {
  return s.mfaVerified || !requiresMfa(s.user.role);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

// ---------------------------------------------------------------------------
// Cookie layer (request context)
// ---------------------------------------------------------------------------

function secureCookies(): boolean {
  // Always Secure except plain-http local development.
  return !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(env().APP_URL);
}

async function setSessionCookie(token: string, expires: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", expires });
}

export async function createSession(userId: string, opts: { mfaVerified: boolean }): Promise<void> {
  const h = await headers();
  const { token, expires } = await issueSession(userId, { mfaVerified: opts.mfaVerified, ip: clientIp(h), userAgent: h.get("user-agent") });
  await setSessionCookie(token, expires);
}

async function currentToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

async function currentSession(): Promise<ResolvedSession | null> {
  return resolveSession(await currentToken());
}

export async function destroySession(): Promise<void> {
  const token = await currentToken();
  if (token) await sql`DELETE FROM sessions WHERE id = ${sha256(token)}`;
  (await cookies()).delete(SESSION_COOKIE);
}

/** Returns the fully authenticated user for this request, or null (including while MFA is pending). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const s = await currentSession();
  return s && isFullyAuthenticated(s) ? s.user : null;
}

/** The user of a session that passed the first factor but still owes MFA. */
export async function getMfaPendingUser(): Promise<SessionUser | null> {
  const s = await currentSession();
  return s && !isFullyAuthenticated(s) ? s.user : null;
}

/** Replaces the current session with a new MFA-verified one (token rotation on privilege change). */
export async function upgradeSessionAfterMfa(userId: string): Promise<void> {
  const token = await currentToken();
  if (token) await sql`DELETE FROM sessions WHERE id = ${sha256(token)}`;
  await createSession(userId, { mfaVerified: true });
}

/** For pages/actions: redirect to /login when there is no fully authenticated session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/");
  return user;
}

/**
 * Client IP for rate limiting. Prefers headers set by the hosting platform; otherwise uses the
 * RIGHTMOST X-Forwarded-For entry (added by our own proxy), never the client-controlled leftmost one.
 */
export function clientIp(h: Headers): string | null {
  const platform = h.get("x-vercel-forwarded-for") ?? h.get("x-real-ip");
  if (platform) return platform.split(",")[0].trim();
  const xff = h.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return xff?.length ? xff[xff.length - 1] : null;
}
