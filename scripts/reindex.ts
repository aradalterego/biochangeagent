/** Rebuilds chunks + embeddings for all approved sources (e.g. after setting OPENAI_API_KEY or changing the embedding model). */
import "dotenv/config";
import { sql, closeDb } from "@/lib/db";
import { indexSource } from "@/server/knowledge/sources";

async function main() {
  const rows = await sql<{ id: string; title: string }[]>`SELECT id, title FROM knowledge_sources WHERE status = 'approved'`;
  for (const r of rows) {
    const res = await indexSource(r.id);
    console.log(`${r.title}: ${res.chunks} chunks${res.embedded ? ", embedded" : ", keyword-only"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
