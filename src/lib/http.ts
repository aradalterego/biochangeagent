import "server-only";
import { env } from "./env";

/**
 * Rejects cross-site state-changing requests (defence in depth on top of SameSite cookies).
 * The Origin must match the configured APP_URL or a hostname Vercel assigned to this deployment;
 * outside staging/production the request host is also accepted.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    const originHost = new URL(origin).host;
    if (originHost === new URL(env().APP_URL).host) return true;
    // Hostnames Vercel assigns to this deployment (set by the platform, not by the request).
    const platformHosts = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
    if (platformHosts.includes(originHost)) return true;
    if (env().APP_ENV === "production" || env().APP_ENV === "staging") return false;
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return originHost === host;
  } catch {
    return false;
  }
}
