import "server-only";
import { sql } from "@/lib/db";
import { embed, toVectorLiteral } from "@/server/ai/openai";

export interface KnowledgeHit {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
  authorityLevel: number;
  product: string | null;
  documentVersion: string | null;
  country: string | null;
  section: string | null;
  page: number | null;
  publicationDate: string | null;
  sourceUrl: string | null;
  content: string;
  relevance: number;
  score: number;
}

export interface KnowledgeQuery {
  query: string;
  product?: string | null;
  sourceTypes?: string[] | null;
  /** Only sources at this authority level or better (1 = IFU/regulatory). */
  authorityThreshold?: number | null;
  market?: string | null;
  limit?: number;
}

const STOPWORDS = new Set(
  "the and for with that this from what when where which who how can does are was were have has had you your our into about there their them they then than will would should could also any all not but use used using its it's per vet dog dogs please".split(" "),
);

/** OR-query of significant terms; only [a-z0-9] reaches to_tsquery, so it is injection-safe. */
export function toOrTsQuery(q: string): string | null {
  const terms = [...new Set(q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((t) => !STOPWORDS.has(t)).slice(0, 24);
  return terms.length ? terms.join(" | ") : null;
}

/**
 * Hybrid retrieval over APPROVED, currently effective, non-placeholder sources only.
 * Ranking blends semantic similarity and keyword relevance, then applies authority,
 * product and recency adjustments. Returns [] rather than weak matches.
 */
export async function searchKnowledge(q: KnowledgeQuery): Promise<KnowledgeHit[]> {
  const limit = Math.min(Math.max(q.limit ?? 5, 1), 8);
  const tsq = toOrTsQuery(q.query);
  let vector: string | null = null;
  try {
    const e = await embed([q.query]);
    vector = e ? toVectorLiteral(e[0]) : null;
  } catch (err) {
    console.error("[knowledge] embedding failed; falling back to keyword search", err);
  }
  if (!tsq && !vector) return [];

  const product = q.product?.trim() || null;
  const types = q.sourceTypes?.length ? q.sourceTypes : null;
  const threshold = q.authorityThreshold ?? 7;
  const market = q.market?.trim() || null;

  const rows = await sql<
    (Omit<KnowledgeHit, "relevance" | "score" | "publicationDate"> & { sim: number | null; kw: number; publication_date: Date | null })[]
  >`
    WITH candidates AS (
      SELECT c.*,
        ${vector ? sql`1 - (c.embedding <=> ${vector}::vector)` : sql`NULL::float`} AS sim,
        ${tsq ? sql`ts_rank_cd(c.tsv, to_tsquery('english', ${tsq}), 32)` : sql`0::float`} AS kw
      FROM knowledge_chunks c
      JOIN knowledge_sources s ON s.id = c.source_id
      WHERE s.status = 'approved'
        AND NOT s.is_placeholder
        AND (s.effective_from IS NULL OR s.effective_from <= current_date)
        AND (s.effective_until IS NULL OR s.effective_until >= current_date)
        AND c.authority_level <= ${threshold}
        AND (${product}::text IS NULL OR c.product IS NULL OR lower(c.product) = lower(${product}))
        AND (${types}::text[] IS NULL OR c.source_type = ANY(${types}::text[]))
        AND (${market}::text IS NULL OR s.country_or_market IN ('global', ${market}))
        AND (
          ${tsq ? sql`c.tsv @@ to_tsquery('english', ${tsq})` : sql`false`}
          OR ${vector ? sql`(c.embedding IS NOT NULL AND 1 - (c.embedding <=> ${vector}::vector) > 0.25)` : sql`false`}
        )
    )
    SELECT c.id AS "chunkId", c.source_id AS "sourceId", c.source_title AS "sourceTitle", c.source_type AS "sourceType",
           c.authority_level AS "authorityLevel", c.product, c.document_version AS "documentVersion", c.country,
           c.section, c.page, c.content, s.source_url AS "sourceUrl", s.publication_date, c.sim, c.kw
    FROM candidates c JOIN knowledge_sources s ON s.id = c.source_id
    ORDER BY coalesce(c.sim, 0) * 0.75 + c.kw DESC
    LIMIT 40`;

  const scored = rows.map((r) => {
    const kw = Math.min(1, r.kw * 3);
    const relevance = r.sim != null ? 0.7 * r.sim + 0.3 * kw : kw;
    const authorityBoost = ((8 - r.authorityLevel) / 7) * 0.15;
    const productBoost = product && r.product && r.product.toLowerCase() === product.toLowerCase() ? 0.05 : 0;
    const ageYears = r.publication_date ? (Date.now() - r.publication_date.getTime()) / (365 * 864e5) : null;
    const recency = r.sourceType === "peer_reviewed_research" && ageYears != null ? Math.max(0, 0.03 - ageYears * 0.003) : 0;
    return {
      chunkId: r.chunkId,
      sourceId: r.sourceId,
      sourceTitle: r.sourceTitle,
      sourceType: r.sourceType,
      authorityLevel: r.authorityLevel,
      product: r.product,
      documentVersion: r.documentVersion,
      country: r.country,
      section: r.section,
      page: r.page,
      sourceUrl: r.sourceUrl,
      publicationDate: r.publication_date ? r.publication_date.toISOString().slice(0, 10) : null,
      content: r.content,
      relevance,
      score: relevance + authorityBoost + productBoost + recency,
    } satisfies KnowledgeHit;
  });

  const minRelevance = vector ? 0.3 : 0.05;
  const perSource = new Map<string, number>();
  return scored
    .filter((h) => h.relevance >= minRelevance)
    .sort((a, b) => b.score - a.score)
    .filter((h) => {
      const n = perSource.get(h.sourceId) ?? 0;
      perSource.set(h.sourceId, n + 1);
      return n < 3;
    })
    .slice(0, limit);
}
