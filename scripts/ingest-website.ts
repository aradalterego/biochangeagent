/**
 * Fetches and parses every registered source that has a URL but no content yet (the public
 * BioChange website pages and the open-access study PDF). Sources stay PENDING REVIEW:
 * an admin must review the extracted text and approve each one before the agent can use it.
 *
 *   npm run kb:ingest-website
 */
import "dotenv/config";
import { sql, closeDb } from "@/lib/db";
import { reparseSource } from "@/server/knowledge/sources";
import type { Actor } from "@/lib/authz";

async function main() {
  const [admin] = await sql<{ id: string }[]>`SELECT id FROM users WHERE role = 'biochange_admin' AND active ORDER BY created_at LIMIT 1`;
  if (!admin) throw new Error("No biochange_admin user exists. Run `npm run admin:bootstrap` first.");
  const actor: Actor = { userId: admin.id, role: "biochange_admin", clinicId: null };
  const rows = await sql<{ id: string; title: string; source_url: string }[]>`
    SELECT id, title, source_url FROM knowledge_sources
    WHERE source_url IS NOT NULL AND storage_path IS NULL AND parse_status IN ('not_parsed', 'failed') AND status = 'pending_review'`;
  for (const r of rows) {
    process.stdout.write(`Fetching ${r.source_url} … `);
    await reparseSource(actor, r.id);
    const [s] = await sql<{ parse_status: string; parse_error: string | null; len: number }[]>`
      SELECT parse_status, parse_error, length(coalesce(extracted_text, ''))::int AS len FROM knowledge_sources WHERE id = ${r.id}`;
    console.log(s.parse_status === "parsed" ? `${s.len} chars (pending review)` : `FAILED: ${s.parse_error}`);
  }
  console.log("Done. Review and approve the sources in Admin → Knowledge Sources.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
