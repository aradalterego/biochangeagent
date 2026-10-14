import "server-only";
import { env } from "./env";

/**
 * Rejects cross-site state-changing requests (defence in depth on top of SameSite cookies).
 * The Origin must match the configured APP_URL, or the request host when APP_URL is local.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    const originHost = new URL(origin).host;
    if (originHost === new URL(env().APP_URL).host) return true;
    if (env().APP_ENV === "production" || env().APP_ENV === "staging") return false;
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return originHost === host;
  } catch {
    return false;
  }
}
