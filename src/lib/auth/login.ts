import "server-only";
import { sql, type Tx } from "@/lib/db";
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "./password";

const WINDOW_MINUTES = 15;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 20;
// A real hash, so that unknown emails take as long to reject as wrong passwords.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomUUID()));

export type LoginResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "locked" };

export async function attemptLogin(email: string, password: string, ip: string | null): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase();
  // Serialise attempts per email so parallel guesses cannot all pass the failure count
  // before any failure is recorded.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`login:${normalized}`}))`;
    return checkAndVerify(tx, normalized, password, ip);
  });
}

async function checkAndVerify(db: Tx, normalized: string, password: string, ip: string | null): Promise<LoginResult> {
  const [{ by_email, by_ip }] = await db<{ by_email: number; by_ip: number }[]>`
    SELECT
      (SELECT count(*)::int FROM login_attempts WHERE email = ${normalized} AND NOT success
         AND attempted_at > now() - make_interval(mins => ${WINDOW_MINUTES})) AS by_email,
      (SELECT count(*)::int FROM login_attempts WHERE ip IS NOT DISTINCT FROM ${ip} AND NOT success
         AND attempted_at > now() - make_interval(mins => ${WINDOW_MINUTES})) AS by_ip`;
  if (by_email >= MAX_FAILURES_PER_EMAIL || (ip && by_ip >= MAX_FAILURES_PER_IP)) {
    return { ok: false, reason: "locked" };
  }

  const [user] = await db<{ id: string; password_hash: string | null; active: boolean }[]>`
    SELECT id, password_hash, active FROM users WHERE email = ${normalized}`;
  const valid = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
  const success = Boolean(user && user.active && user.password_hash && valid);

  await db`INSERT INTO login_attempts (email, ip, success) VALUES (${normalized}, ${ip}, ${success})`;
  if (!success || !user) return { ok: false, reason: "invalid" };
  return { ok: true, userId: user.id };
}
