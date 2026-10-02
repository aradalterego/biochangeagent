import "server-only";
import postgres from "postgres";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __bcSql: postgres.Sql | undefined;
}

function instance(): postgres.Sql {
  if (!globalThis.__bcSql) {
    const url = env().DATABASE_URL;
    globalThis.__bcSql = postgres(url, {
      max: 10,
      idle_timeout: 20,
      // Supabase's transaction pooler (port 6543) does not support prepared statements.
      prepare: !url.includes(":6543"),
      onnotice: () => {},
      transform: { undefined: null },
    });
  }
  return globalThis.__bcSql;
}

/**
 * Shared connection pool, created lazily on first use (so builds don't need a database)
 * and reused across hot reloads in development.
 */
export const sql = new Proxy(function () {} as unknown as postgres.Sql, {
  apply: (_t, _this, args) => (instance() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, prop) => {
    const value = Reflect.get(instance(), prop);
    return typeof value === "function" ? value.bind(instance()) : value;
  },
});

export type Tx = postgres.TransactionSql | postgres.Sql;

export async function closeDb() {
  if (globalThis.__bcSql) {
    await globalThis.__bcSql.end({ timeout: 5 });
    globalThis.__bcSql = undefined;
  }
}
