/**
 * Applies SQL migrations in db/migrations in filename order, each inside a transaction.
 * Usage: tsx scripts/migrate.ts [--reset]   (--reset drops the public schema first — dev only)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = postgres(url, { max: 1, onnotice: () => {} });
const dir = path.resolve("db/migrations");

async function main() {
  if (process.argv.includes("--reset")) {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production");
    console.log("Resetting public schema…");
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  }
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`applied ${file}`);
  }
  await sql`ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY`;
  console.log("migrations up to date");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
