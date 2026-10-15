/**
 * Loads the approved knowledge files listed in knowledge/manifest.json as knowledge sources.
 * Every source is created in PENDING REVIEW: an admin must review the text and approve it in
 * Admin → Knowledge Sources before the agent can use it. Files already imported with the same
 * content are skipped, so the script can be re-run safely.
 *
 *   npm run kb:import
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql, closeDb } from "@/lib/db";
import { createSource } from "@/server/knowledge/sources";
import { SOURCE_TYPES, type SourceType } from "@/server/knowledge/constants";
import type { Actor } from "@/lib/authz";

interface ManifestEntry {
  file: string;
  title: string;
  sourceType: SourceType;
  product: string | null;
  version?: string;
  language?: string;
  originalPdf?: string;
}

const DIR = path.join(process.cwd(), "knowledge");

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(DIR, "manifest.json"), "utf8")) as { sources: ManifestEntry[] };
  const [admin] = await sql<{ id: string }[]>`SELECT id FROM users WHERE role = 'biochange_admin' AND active ORDER BY created_at LIMIT 1`;
  if (!admin) throw new Error("No biochange_admin user exists. Run `npm run admin:bootstrap` first.");
  const actor: Actor = { userId: admin.id, role: "biochange_admin", clinicId: null };

  for (const s of manifest.sources) {
    if (!SOURCE_TYPES.includes(s.sourceType)) throw new Error(`${s.file}: unknown sourceType "${s.sourceType}"`);
    const data = await fs.readFile(path.join(DIR, s.file));
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    const [existing] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM knowledge_sources WHERE content_hash = ${hash} AND status <> 'revoked' LIMIT 1`;
    if (existing) {
      console.log(`skip  ${s.file} (already imported, ${existing.status})`);
      continue;
    }
    await createSource(
      actor,
      {
        title: s.title,
        sourceType: s.sourceType,
        product: s.product,
        version: s.version ?? null,
        clinicalOrCommercial: "clinical",
        tags: ["ifu-import", ...(s.language ? [`lang-${s.language}`] : [])],
        notes: s.originalPdf ? `Transcribed from ${s.originalPdf}. Check the text against the original leaflet before approving.` : null,
      },
      { file: { name: s.file, data } },
    );
    console.log(`added ${s.file} (pending review)`);
  }
  console.log("Done. Review and approve the sources in Admin → Knowledge Sources.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
