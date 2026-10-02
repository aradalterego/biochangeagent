import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import type { Role } from "@/lib/roles";

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

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString("base64url");
  const ttlHours = env().SESSION_TTL_HOURS;
  const expires = new Date(Date.now() + ttlHours * 3600_000);
  const h = await headers();
  await sql`
    INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
    VALUES (${hashToken(token)}, ${userId}, ${expires}, ${clientIp(h)}, ${h.get("user-agent")?.slice(0, 300) ?? null})`;
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await sql`DELETE FROM sessions WHERE id = ${hashToken(token)}`;
  jar.delete(SESSION_COOKIE);
}

/** Returns the authenticated user for this request, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await sql<
    {
      id: string; email: string; name: string; role: Role; clinic_id: string | null; timezone: string;
      preferred_language: string; professional_title: string | null; country: string | null; last_active_at: Date | null;
    }[]
  >`
    SELECT u.id, u.email, u.name, u.role, u.clinic_id, u.timezone, u.preferred_language,
           u.professional_title, u.country, u.last_active_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${hashToken(token)} AND s.expires_at > now() AND u.active`;
  const u = rows[0];
  if (!u) return null;
  if (!u.last_active_at || Date.now() - u.last_active_at.getTime() > 5 * 60_000) {
    await sql`UPDATE users SET last_active_at = now() WHERE id = ${u.id}`;
  }
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    clinicId: u.clinic_id,
    timezone: u.timezone,
    preferredLanguage: u.preferred_language,
    professionalTitle: u.professional_title,
    country: u.country,
  };
}

/** For pages/actions: redirect to /login when there is no session. */
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

export function clientIp(h: Headers): string | null {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}
