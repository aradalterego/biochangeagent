import "server-only";
import { sql } from "./db";
import { ValidationError } from "./authz";

/**
 * Sliding-window limiter backed by Postgres (no extra infrastructure). Returns false when
 * `key` already has `max` hits in the last `windowSeconds`; otherwise records a hit.
 */
export async function hit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`rl:${key}`}))`;
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rate_limit_hits WHERE key = ${key} AND at > now() - make_interval(secs => ${windowSeconds})`;
    if (n >= max) return false;
    await tx`INSERT INTO rate_limit_hits (key) VALUES (${key})`;
    // Opportunistic cleanup keeps the table small.
    if (Math.random() < 0.02) await tx`DELETE FROM rate_limit_hits WHERE at < now() - interval '1 day'`;
    return true;
  });
}

export async function enforce(key: string, max: number, windowSeconds: number, message = "Too many requests. Please wait a few minutes and try again."): Promise<void> {
  if (!(await hit(key, max, windowSeconds))) throw new ValidationError(message);
}
