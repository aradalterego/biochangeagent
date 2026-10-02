import { AuthorizationError, NotFoundError, ValidationError } from "./authz";

export type ActionState = { error?: string; ok?: string } | undefined;

/** Converts expected domain errors into form messages; unexpected errors are logged and hidden. */
export async function runAction(fn: () => Promise<string | void>): Promise<ActionState> {
  try {
    const ok = await fn();
    return { ok: ok || "Saved." };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError || err instanceof NotFoundError) return { error: err.message };
    // Next.js redirects/notFound are thrown as errors and must propagate.
    if (err && typeof err === "object" && "digest" in err) throw err;
    console.error("[action] failed", err);
    return { error: "Something went wrong. Please try again." };
  }
}

export function str(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function num(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`${key} must be a number`);
  return n;
}
