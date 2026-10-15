"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { attemptLogin } from "@/lib/auth/login";
import {
  clientIp, createSession, destroySession, getMfaPendingUser, getSessionUser, requireUser, requiresMfa, revokeAllSessions, upgradeSessionAfterMfa,
} from "@/lib/auth/session";
import { IdentityError, verifySignInLink } from "@/lib/auth/identity";
import { completeSignIn, recordFailure, requestSignInLink, verifyMfaCode, isDemoAccount } from "@/lib/auth/signin";
import { hit } from "@/lib/rateLimit";
import { isDemoEnvironment, isProductionLike } from "@/lib/env";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { actorFromSession } from "@/lib/authz";
import { log } from "@/lib/log";

type FormState = { error?: string; ok?: string } | undefined;

const NEUTRAL_LINK_MESSAGE = "If this email belongs to an invited account, a sign-in link is on its way. It expires in 15 minutes.";

/** Primary sign-in for veterinarians: a one-time link by email (invite-only). */
export async function requestLinkAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "").trim();
  if (!email) return { error: "Enter your email address." };
  const ip = clientIp(await headers());
  // The lookup and email run after the response, so neither the message nor the response
  // time reveals whether the address is registered.
  after(() => requestSignInLink(email, ip).catch((err) => log.error("auth.link_request_failed", { err })));
  return { ok: NEUTRAL_LINK_MESSAGE };
}

/** Second step of the magic link: the person presses "Continue" (so mail scanners that prefetch links cannot consume them). */
export async function confirmLinkAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ip = clientIp(await headers());
  let target = "/";
  try {
    const identity = await verifySignInLink({
      token: str(fd.get("token")),
      tokenHash: str(fd.get("token_hash")),
      type: str(fd.get("type")),
    });
    const result = await completeSignIn(identity, ip);
    if (!result.ok) return { error: "This email address is not registered for BioChange. Contact BioChange for an invitation." };
    await createSession(result.userId, { mfaVerified: false });
    if (requiresMfa(result.role)) target = "/login/mfa";
  } catch (err) {
    if (err instanceof IdentityError) return { error: err.message };
    log.error("auth.link_confirm_failed", { err });
    return { error: "Sign-in failed. Please request a new link." };
  }
  redirect(target);
}

/** Email + password: kept for BioChange staff (always followed by MFA when required). */
export async function passwordLoginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  const ip = clientIp(await headers());
  if (isDemoAccount(email) && isProductionLike() && !isDemoEnvironment()) {
    await recordFailure(email.toLowerCase(), ip, null, "demo_account_refused");
    return { error: "Incorrect email or password." };
  }
  const result = await attemptLogin(email, password, ip);
  if (!result.ok) {
    await sql`INSERT INTO audit_log (action, entity_type, tool, input_summary, result) VALUES ('auth.login_failed', 'user', 'ui', ${`password (${result.reason})`}, 'denied')`;
    return { error: result.reason === "locked" ? "Too many failed attempts. Please wait 15 minutes and try again." : "Incorrect email or password." };
  }
  const [u] = await sql<{ role: Parameters<typeof requiresMfa>[0] }[]>`UPDATE users SET last_login_at = now() WHERE id = ${result.userId} RETURNING role`;
  await createSession(result.userId, { mfaVerified: false });
  await sql`INSERT INTO audit_log (user_id, action, entity_type, entity_id, tool, input_summary, result) VALUES (${result.userId}, 'auth.login', 'user', ${result.userId}, 'ui', 'password', 'success')`;
  redirect(requiresMfa(u.role) ? "/login/mfa" : "/");
}

export async function verifyMfaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await getMfaPendingUser();
  if (!user) redirect((await getSessionUser()) ? "/" : "/login");
  if (!(await hit(`mfa:${user.id}`, 8, 15 * 60))) return { error: "Too many attempts. Please wait 15 minutes." };
  const ok = await verifyMfaCode(user.id, String(fd.get("code") ?? ""));
  if (!ok) return { error: "That code is not valid. Check the time on your phone and try the newest code." };
  await upgradeSessionAfterMfa(user.id);
  redirect("/");
}

export async function logoutAction() {
  const user = (await getSessionUser()) ?? (await getMfaPendingUser());
  await destroySession();
  if (user) await sql`INSERT INTO audit_log (user_id, action, entity_type, entity_id, tool, result) VALUES (${user.id}, 'auth.logout', 'user', ${user.id}, 'ui', 'success')`;
  redirect("/login");
}

/** Signs the user out on every device. */
export async function logoutEverywhereAction() {
  const user = await requireUser();
  await revokeAllSessions(user.id);
  await destroySession();
  await audit(actorFromSession(user), { action: "auth.logout_all", entityType: "user", entityId: user.id, tool: "ui" });
  redirect("/login");
}

function str(v: FormDataEntryValue | null): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
