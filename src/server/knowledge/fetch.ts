import "server-only";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/authz";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Fetches an admin-entered source URL. Only https URLs on the configured allow-list
 * (KNOWLEDGE_FETCH_ALLOWED_HOSTS) are fetched, including after redirects, so the server
 * cannot be used to reach internal hosts.
 */
export async function fetchApprovedUrl(rawUrl: string): Promise<{ url: string; contentType: string; body: Buffer }> {
  let url = assertAllowed(rawUrl);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "BioChangeVetCompanion/1.0 (knowledge ingestion)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new ValidationError("Redirect without location");
      url = assertAllowed(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new ValidationError(`Fetching ${url} failed with HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new ValidationError("Remote document is too large");
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) throw new ValidationError("Remote document is too large");
    return { url, contentType: res.headers.get("content-type") ?? "", body };
  }
  throw new ValidationError("Too many redirects");
}

export function allowedHosts(): string[] {
  return env()
    .KNOWLEDGE_FETCH_ALLOWED_HOSTS.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function assertAllowed(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError("Invalid URL");
  }
  if (u.protocol !== "https:") throw new ValidationError("Only https URLs can be ingested");
  if (u.username || u.password || (u.port && u.port !== "443")) throw new ValidationError("URL not allowed");
  const host = u.hostname.toLowerCase();
  const ok = allowedHosts().some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) throw new ValidationError(`Host ${host} is not on the approved ingestion list (${allowedHosts().join(", ")})`);
  u.hash = "";
  return u.toString();
}
