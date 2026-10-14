import "server-only";
import { env } from "./env";
import { log } from "./log";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transactional email. "resend" in staging/production; "log" (development only) writes the
 * message to the server log so sign-in links can be used locally; "none" drops it.
 */
export async function sendEmail(msg: Email): Promise<void> {
  const e = env();
  if (e.EMAIL_DRIVER === "none") return;
  if (e.EMAIL_DRIVER === "log") {
    if (e.APP_ENV === "production" || e.APP_ENV === "staging") throw new Error("EMAIL_DRIVER=log is not allowed outside development.");
    // Development only: the body may contain a one-time sign-in link.
    console.log(`\n--- email (dev) to ${msg.to}: ${msg.subject}\n${msg.text}\n---\n`);
    return;
  }
  if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: e.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    log.error("email.send_failed", { status: res.status });
    throw new Error(`Email could not be sent (${res.status}).`);
  }
}
