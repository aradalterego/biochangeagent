/**
 * Structured (JSON-line) logging with redaction.
 *
 * Logs must never contain clinical payloads, credentials or tokens. Errors are reduced to
 * their name, code and a scrubbed message: database errors in particular carry the query
 * parameters (i.e. the clinical values) on `parameters`/`query`/`detail`, which are dropped.
 */

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|service[-_]?role|totp/i;

export function describeError(err: unknown): Fields {
  if (!(err instanceof Error)) return { error: typeof err === "string" ? scrub(err) : "non-error thrown" };
  const e = err as Error & { code?: unknown; status?: unknown };
  const out: Fields = { error: e.name, message: scrub(e.message) };
  if (typeof e.code === "string" || typeof e.code === "number") out.code = e.code;
  if (typeof e.status === "number") out.status = e.status;
  if (process.env.APP_ENV !== "production" && e.stack) out.stack = e.stack.split("\n").slice(1, 6).map((l) => l.trim());
  return out;
}

/** Removes quoted values (Postgres embeds offending input in quotes) and caps length. */
function scrub(message: string): string {
  return message.replace(/"[^"]*"/g, '"…"').replace(/'[^']{12,}'/g, "'…'").slice(0, 300);
}

function sanitize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) out[k] = "[redacted]";
    else if (k === "err") Object.assign(out, describeError(v));
    else if (typeof v === "string") out[k] = v.slice(0, 300);
    else if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = "[object]";
  }
  return out;
}

function write(level: Level, event: string, fields: Fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...sanitize(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
