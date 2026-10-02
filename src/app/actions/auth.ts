"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { attemptLogin } from "@/lib/auth/login";
import { clientIp, createSession, destroySession, getSessionUser } from "@/lib/auth/session";
import { sql } from "@/lib/db";

export async function loginAction(_prev: { error?: string } | undefined, fd: FormData): Promise<{ error?: string }> {
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  const ip = clientIp(await headers());
  const result = await attemptLogin(email, password, ip);
  if (!result.ok) {
    return { error: result.reason === "locked" ? "Too many failed attempts. Please wait 15 minutes and try again." : "Incorrect email or password." };
  }
  await createSession(result.userId);
  await sql`INSERT INTO audit_log (user_id, action, entity_type, entity_id, tool, result) VALUES (${result.userId}, 'auth.login', 'user', ${result.userId}, 'ui', 'success')`;
  redirect("/");
}

export async function logoutAction() {
  const user = await getSessionUser();
  await destroySession();
  if (user) await sql`INSERT INTO audit_log (user_id, action, entity_type, entity_id, tool, result) VALUES (${user.id}, 'auth.logout', 'user', ${user.id}, 'ui', 'success')`;
  redirect("/login");
}
