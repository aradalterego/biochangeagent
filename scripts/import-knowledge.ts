/**
 * Loads the approved knowledge files listed in knowledge/manifest.json as knowledge sources.
 * Every source is created in PENDING REVIEW: an admin must review the text and approve it in
 * Admin → Knowledge Sources before the agent can use it. An empty placeholder for the same product
 * and source type (e.g. "ReGum Vet — current approved IFU") is filled instead of adding a new source.
 * Each source is tagged with its file name; files already imported are skipped, so the script can be
 * re-run safely and never overwrites text edited in the admin screen.
 *
 *   npm run kb:import
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql, closeDb } from "@/lib/db";
import { createSource, updateSource, type SourceInput } from "@/server/knowledge/sources";
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
    const fileTag = `kb-file:${s.file}`;
    const [existing] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM knowledge_sources
      WHERE status <> 'revoked' AND (${fileTag} = ANY(tags) OR content_hash = ${hash}) LIMIT 1`;
    if (existing) {
      console.log(`skip  ${s.file} (already imported, ${existing.status})`);
      continue;
    }
    const input: SourceInput = {
      title: s.title,
      sourceType: s.sourceType,
      product: s.product,
      version: s.version ?? null,
      clinicalOrCommercial: "clinical",
      tags: ["ifu-import", fileTag, ...(s.language ? [`lang-${s.language}`] : [])],
      notes: s.originalPdf ? `Transcribed from ${s.originalPdf}. Check the text against the original leaflet before approving.` : null,
    };
    const [placeholder] = await sql<{ id: string }[]>`
      SELECT id FROM knowledge_sources
      WHERE is_placeholder AND status = 'pending_review' AND source_type = ${s.sourceType} AND product IS NOT DISTINCT FROM ${s.product}
      ORDER BY created_at LIMIT 1`;
    if (placeholder) {
      await updateSource(actor, placeholder.id, { ...input, extractedText: data.toString("utf8") });
      console.log(`fill  ${s.file} → placeholder ${placeholder.id} (pending review)`);
      continue;
    }
    await createSource(actor, input, { file: { name: s.file, data } });
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
