import "server-only";
import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertKnowledgeManager, NotFoundError, ValidationError, type Actor } from "@/lib/authz";
import { putFile, readFile, sanitizeFileName } from "@/lib/storage";
import { embed, toVectorLiteral } from "@/server/ai/openai";
import { chunkDocument } from "./chunk";
import { CRITICAL_DOCUMENTS, DEFAULT_AUTHORITY, SOURCE_TYPES, type SourceType } from "./constants";
import { fetchApprovedUrl } from "./fetch";
import { parseHtml, parsePdf, parseText, type ParsedDocument } from "./parse";

export interface SourceRow {
  id: string;
  title: string;
  source_type: SourceType;
  product: string | null;
  authority_level: number;
  source_url: string | null;
  storage_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  publication_date: Date | null;
  version: string | null;
  country_or_market: string;
  regulatory_status: string | null;
  status: "pending_review" | "approved" | "revoked" | "superseded";
  approved_for_agent: boolean;
  clinical_or_commercial: "clinical" | "commercial" | "both";
  tags: string[];
  extracted_text: string | null;
  parse_status: "not_parsed" | "parsed" | "failed" | "placeholder";
  parse_error: string | null;
  is_placeholder: boolean;
  linked_documents: { url: string; label: string }[];
  supersedes_source_id: string | null;
  last_reviewed_at: Date | null;
  reviewed_by: string | null;
  reviewer_name?: string | null;
  effective_from: Date | null;
  effective_until: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  chunk_count?: number;
}

export interface SourceInput {
  title: string;
  sourceType: SourceType;
  product?: string | null;
  authorityLevel?: number | null;
  sourceUrl?: string | null;
  publicationDate?: string | null;
  version?: string | null;
  countryOrMarket?: string | null;
  regulatoryStatus?: string | null;
  clinicalOrCommercial?: "clinical" | "commercial" | "both";
  tags?: string[];
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  supersedesSourceId?: string | null;
  notes?: string | null;
}

const MAX_UPLOAD = 25 * 1024 * 1024;

export async function listSources(actor: Actor, filter: { status?: string; product?: string } = {}): Promise<SourceRow[]> {
  assertKnowledgeManager(actor);
  return sql<SourceRow[]>`
    SELECT s.*, u.name AS reviewer_name,
      (SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id = s.id) AS chunk_count
    FROM knowledge_sources s LEFT JOIN users u ON u.id = s.reviewed_by
    WHERE (${filter.status ?? null}::text IS NULL OR s.status = ${filter.status ?? null})
      AND (${filter.product ?? null}::text IS NULL OR s.product = ${filter.product ?? null})
    ORDER BY s.authority_level, s.product NULLS LAST, s.updated_at DESC`;
}

/**
 * Staff see every source. Everyone else may only open sources that are currently approved
 * (the "View source" link under an answer).
 */
export async function getSource(actor: Actor, id: string): Promise<SourceRow & { study: Record<string, unknown> | null }> {
  const [row] = await sql<SourceRow[]>`
    SELECT s.*, u.name AS reviewer_name,
      (SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id = s.id) AS chunk_count
    FROM knowledge_sources s LEFT JOIN users u ON u.id = s.reviewed_by WHERE s.id = ${id}`;
  if (!row) throw new NotFoundError("Source not found");
  const staff = actor.role === "biochange_admin" || actor.role === "biochange_medical";
  if (!staff && row.status !== "approved") throw new NotFoundError("Source not found");
  const [study] = await sql`SELECT * FROM evidence_studies WHERE source_id = ${id}`;
  return { ...row, study: study ?? null };
}

export async function getChunk(actor: Actor, chunkId: string) {
  const [row] = await sql<{ id: string; source_id: string; content: string; section: string | null; page: number | null }[]>`
    SELECT c.id, c.source_id, c.content, c.section, c.page
    FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
    WHERE c.id = ${chunkId}`;
  if (!row) throw new NotFoundError("Passage not found");
  await getSource(actor, row.source_id); // applies visibility rules
  return row;
}

function validateInput(input: SourceInput) {
  if (!input.title?.trim()) throw new ValidationError("Title is required.");
  if (input.sourceUrl?.trim()) {
    let u: URL;
    try {
      u = new URL(input.sourceUrl.trim());
    } catch {
      throw new ValidationError("Source URL is not a valid URL.");
    }
    if (u.protocol !== "https:") throw new ValidationError("Source URL must use https.");
  }
  if (!SOURCE_TYPES.includes(input.sourceType)) throw new ValidationError("Unknown source type.");
  const level = input.authorityLevel ?? DEFAULT_AUTHORITY[input.sourceType];
  if (!Number.isInteger(level) || level < 1 || level > 7) throw new ValidationError("Authority level must be 1–7.");
  return level;
}

/** Creates a source record in PENDING REVIEW from an upload or an approved URL, and parses it. */
export async function createSource(
  actor: Actor,
  input: SourceInput,
  content: { file?: { name: string; data: Buffer }; fetchUrl?: boolean } = {},
): Promise<string> {
  assertKnowledgeManager(actor);
  const level = validateInput(input);

  let parsed: ParsedDocument | null = null;
  let parseError: string | null = null;
  let stored: { storagePath: string; mimeType: string; sha256: string } | null = null;
  let fileName: string | null = null;
  let sourceUrl = input.sourceUrl?.trim() || null;

  try {
    if (content.file) {
      const f = await putFile("knowledge", content.file.data, ["pdf", "text"], MAX_UPLOAD);
      stored = f;
      fileName = sanitizeFileName(content.file.name);
      parsed = f.kind === "pdf" ? await parsePdf(content.file.data) : parseText(content.file.data);
    } else if (content.fetchUrl && sourceUrl) {
      const res = await fetchApprovedUrl(sourceUrl);
      sourceUrl = res.url;
      parsed = await parseFetched(res);
    }
  } catch (err) {
    if (err instanceof ValidationError && !parsed && !stored && content.file) throw err;
    parseError = err instanceof Error ? err.message : String(err);
  }

  const text = parsed ? serializePages(parsed) : null;
  if (parsed && !text && !parseError) parseError = "No readable text found in the document.";
  const parseStatus = parsed && text ? "parsed" : parseError ? "failed" : "not_parsed";

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO knowledge_sources (
      title, source_type, product, authority_level, source_url, storage_path, file_name, mime_type, content_hash,
      publication_date, version, country_or_market, regulatory_status, clinical_or_commercial, tags,
      extracted_text, parse_status, parse_error, supersedes_source_id, effective_from, effective_until, notes, created_by, linked_documents)
    VALUES (
      ${input.title.trim()}, ${input.sourceType}, ${input.product || null}, ${level}, ${sourceUrl}, ${stored?.storagePath ?? null},
      ${fileName}, ${stored?.mimeType ?? null}, ${stored?.sha256 ?? (text ? sha(text) : null)},
      ${input.publicationDate || null}, ${input.version || null}, ${input.countryOrMarket || "global"}, ${input.regulatoryStatus || null},
      ${input.clinicalOrCommercial ?? "clinical"}, ${input.tags ?? []},
      ${text}, ${parseStatus}, ${parseError}, ${input.supersedesSourceId || null}, ${input.effectiveFrom || null},
      ${input.effectiveUntil || null}, ${input.notes || null}, ${actor.userId}, ${sql.json((parsed?.linkedDocuments ?? []) as never)})
    RETURNING id`;
  await audit(actor, {
    action: "knowledge_source.create",
    entityType: "knowledge_source",
    entityId: row.id,
    tool: "admin",
    inputSummary: `${input.sourceType}: ${input.title}${parseError ? ` (parse failed: ${parseError})` : ""}`,
  });
  return row.id;
}

async function parseFetched(res: { url: string; contentType: string; body: Buffer }): Promise<ParsedDocument> {
  if (res.contentType.includes("pdf") || res.body.subarray(0, 5).toString("latin1") === "%PDF-") return parsePdf(res.body);
  if (res.contentType.includes("html")) return parseHtml(res.body.toString("utf8"), res.url);
  return parseText(res.body);
}

/** Re-fetches / re-parses the source content (stays in its current review state, but unapproved). */
export async function reparseSource(actor: Actor, id: string): Promise<void> {
  assertKnowledgeManager(actor);
  const src = await getSource(actor, id);
  let parsed: ParsedDocument | null = null;
  let error: string | null = null;
  try {
    if (src.storage_path) {
      const buf = await readFile(src.storage_path);
      parsed = buf.subarray(0, 5).toString("latin1") === "%PDF-" ? await parsePdf(buf) : parseText(buf);
    } else if (src.source_url) {
      parsed = await parseFetched(await fetchApprovedUrl(src.source_url));
    } else {
      throw new ValidationError("Nothing to parse: no file or URL.");
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const text = parsed ? serializePages(parsed) : null;
  if (parsed && !text && !error) error = "No readable text found in the document.";
  // Changed content must be reviewed again before the agent may use it.
  await sql.begin(async (tx) => {
    await tx`
      UPDATE knowledge_sources SET
        extracted_text = coalesce(${text}, extracted_text),
        parse_status = ${text ? "parsed" : "failed"}, parse_error = ${error},
        linked_documents = ${sql.json((parsed?.linkedDocuments ?? []) as never)},
        is_placeholder = CASE WHEN ${text}::text IS NOT NULL THEN false ELSE is_placeholder END,
        status = CASE WHEN status = 'approved' AND ${text}::text IS DISTINCT FROM extracted_text THEN 'pending_review' ELSE status END,
        updated_at = now()
      WHERE id = ${id}`;
    const [s] = await tx<{ status: string }[]>`SELECT status FROM knowledge_sources WHERE id = ${id}`;
    if (s.status !== "approved") await tx`DELETE FROM knowledge_chunks WHERE source_id = ${id}`;
    await audit(actor, { action: "knowledge_source.reparse", entityType: "knowledge_source", entityId: id, tool: "admin", result: error ? "error" : "success", inputSummary: error }, tx);
  });
}

export async function updateSource(actor: Actor, id: string, input: SourceInput & { extractedText?: string | null }): Promise<void> {
  assertKnowledgeManager(actor);
  const level = validateInput(input);
  const before = await getSource(actor, id);
  const textChanged = input.extractedText != null && input.extractedText !== before.extracted_text;
  await sql.begin(async (tx) => {
    await tx`
      UPDATE knowledge_sources SET
        title = ${input.title.trim()}, source_type = ${input.sourceType}, product = ${input.product || null},
        authority_level = ${level}, source_url = ${input.sourceUrl || null}, publication_date = ${input.publicationDate || null},
        version = ${input.version || null}, country_or_market = ${input.countryOrMarket || "global"},
        regulatory_status = ${input.regulatoryStatus || null}, clinical_or_commercial = ${input.clinicalOrCommercial ?? "clinical"},
        tags = ${input.tags ?? []}, effective_from = ${input.effectiveFrom || null}, effective_until = ${input.effectiveUntil || null},
        supersedes_source_id = ${input.supersedesSourceId || null}, notes = ${input.notes || null},
        extracted_text = ${textChanged ? input.extractedText! : before.extracted_text},
        parse_status = CASE WHEN ${textChanged} THEN 'parsed' ELSE parse_status END,
        is_placeholder = CASE WHEN ${textChanged} THEN false ELSE is_placeholder END,
        -- edited clinical content goes back to review
        status = CASE WHEN ${textChanged} AND status = 'approved' THEN 'pending_review' ELSE status END,
        updated_at = now()
      WHERE id = ${id}`;
    await audit(actor, { action: "knowledge_source.update", entityType: "knowledge_source", entityId: id, tool: "admin", inputSummary: textChanged ? "metadata + content edited (returned to review)" : "metadata edited" }, tx);
  });
  const [after] = await sql<{ status: string }[]>`SELECT status FROM knowledge_sources WHERE id = ${id}`;
  if (after.status === "approved") await indexSource(id);
  else await sql`DELETE FROM knowledge_chunks WHERE source_id = ${id}`;
}

/**
 * Marks a reviewed source APPROVED FOR AGENT and indexes it. If it supersedes an older
 * version, the older version is marked superseded and removed from retrieval.
 */
export async function approveSource(actor: Actor, id: string): Promise<{ chunks: number; embedded: boolean }> {
  assertKnowledgeManager(actor);
  const src = await getSource(actor, id);
  if (src.is_placeholder || !src.extracted_text?.trim()) {
    throw new ValidationError("This source has no reviewed content yet. Upload the document or fetch the URL, review the extracted text, then approve.");
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE knowledge_sources SET status = 'approved', last_reviewed_at = now(), reviewed_by = ${actor.userId}, updated_at = now() WHERE id = ${id}`;
    if (src.supersedes_source_id) {
      await tx`UPDATE knowledge_sources SET status = 'superseded', updated_at = now() WHERE id = ${src.supersedes_source_id} AND status = 'approved'`;
      await tx`DELETE FROM knowledge_chunks WHERE source_id = ${src.supersedes_source_id}`;
    }
    await audit(actor, { action: "knowledge_source.approve", entityType: "knowledge_source", entityId: id, tool: "admin", inputSummary: `${src.title}${src.supersedes_source_id ? ` (supersedes ${src.supersedes_source_id})` : ""}` }, tx);
  });
  return indexSource(id);
}

export async function revokeSource(actor: Actor, id: string, reason: string | null): Promise<void> {
  assertKnowledgeManager(actor);
  await getSource(actor, id);
  await sql.begin(async (tx) => {
    await tx`UPDATE knowledge_sources SET status = 'revoked', last_reviewed_at = now(), reviewed_by = ${actor.userId},
             notes = concat_ws(E'\n', notes, ${reason ? `Revoked: ${reason}` : null}::text), updated_at = now() WHERE id = ${id}`;
    await tx`DELETE FROM knowledge_chunks WHERE source_id = ${id}`;
    await audit(actor, { action: "knowledge_source.revoke", entityType: "knowledge_source", entityId: id, tool: "admin", inputSummary: reason }, tx);
  });
}

/** (Re)builds the retrieval chunks for an approved source. */
export async function indexSource(id: string): Promise<{ chunks: number; embedded: boolean }> {
  const [src] = await sql<SourceRow[]>`SELECT * FROM knowledge_sources WHERE id = ${id}`;
  if (!src || src.status !== "approved" || !src.extracted_text) {
    await sql`DELETE FROM knowledge_chunks WHERE source_id = ${id}`;
    return { chunks: 0, embedded: false };
  }
  const chunks = chunkDocument(deserializePages(src.extracted_text));
  let vectors: number[][] | null = null;
  try {
    vectors = await embed(chunks.map((c) => `${src.title}${c.section ? ` — ${c.section}` : ""}\n${c.content}`));
  } catch (err) {
    console.error("[knowledge] embedding failed; chunks indexed for keyword search only", err);
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM knowledge_chunks WHERE source_id = ${id}`;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await tx`
        INSERT INTO knowledge_chunks (source_id, chunk_index, content, source_title, source_type, authority_level, product,
          document_version, country, section, page, claim_type, approved_status, embedding)
        VALUES (${id}, ${i}, ${c.content}, ${src.title}, ${src.source_type}, ${src.authority_level}, ${src.product},
          ${src.version}, ${src.country_or_market}, ${c.section}, ${c.page}, ${claimTypeFor(src.source_type)}, ${src.status},
          ${vectors ? toVectorLiteral(vectors[i]) : null}::vector)`;
    }
  });
  return { chunks: chunks.length, embedded: Boolean(vectors) };
}

function claimTypeFor(type: SourceType): string {
  if (type === "peer_reviewed_research" || type === "case_study") return "clinical_evidence";
  if (type === "commercial_information" || type === "distributor_material" || type === "product_page") return "commercial";
  if (type === "ifu" || type === "clinical_protocol") return "handling";
  return "other";
}

/** Critical documents with no approved, real (non-placeholder) source yet. */
export async function missingCriticalDocuments(): Promise<typeof CRITICAL_DOCUMENTS> {
  const rows = await sql<{ source_type: string; product: string | null; title: string }[]>`
    SELECT source_type, product, title FROM knowledge_sources WHERE status = 'approved' AND NOT is_placeholder AND NOT ('demo-mock' = ANY(tags))`;
  return CRITICAL_DOCUMENTS.filter((doc) => {
    return !rows.some((r) => {
      if (!doc.sourceTypes.includes(r.source_type as SourceType)) return false;
      if (doc.product && r.product !== doc.product) return false;
      if (doc.key === "claims-matrix") return /claim/i.test(r.title);
      return true;
    });
  });
}

export async function upsertStudy(actor: Actor, sourceId: string, s: Record<string, string | string[] | number | null>): Promise<void> {
  assertKnowledgeManager(actor);
  await sql`
    INSERT INTO evidence_studies (source_id, publication, authors, journal, year, study_design, sample_size, intervention, control,
      outcomes, limitations, funding_conflicts, key_approved_claims)
    VALUES (${sourceId}, ${s.publication as string}, ${s.authors as string}, ${s.journal as string}, ${(s.year as number) ?? null},
      ${s.study_design as string}, ${s.sample_size as string}, ${s.intervention as string}, ${s.control as string},
      ${s.outcomes as string}, ${s.limitations as string}, ${s.funding_conflicts as string}, ${(s.key_approved_claims as string[]) ?? []})
    ON CONFLICT (source_id) DO UPDATE SET publication = EXCLUDED.publication, authors = EXCLUDED.authors, journal = EXCLUDED.journal,
      year = EXCLUDED.year, study_design = EXCLUDED.study_design, sample_size = EXCLUDED.sample_size,
      intervention = EXCLUDED.intervention, control = EXCLUDED.control, outcomes = EXCLUDED.outcomes,
      limitations = EXCLUDED.limitations, funding_conflicts = EXCLUDED.funding_conflicts, key_approved_claims = EXCLUDED.key_approved_claims`;
  await audit(actor, { action: "evidence_study.upsert", entityType: "knowledge_source", entityId: sourceId, tool: "admin" });
}

// Pages are stored in extracted_text with page markers so chunks keep page numbers.
const PAGE_MARK = /^\[\[page (\d+)\]\]$/;

export function serializePages(doc: ParsedDocument): string | null {
  const text = doc.pages
    .filter((p) => p.text.trim())
    .map((p) => (p.page != null ? `[[page ${p.page}]]\n${p.text}` : p.text))
    .join("\n\n");
  return text.trim() ? text : null;
}

export function deserializePages(text: string): { page: number | null; text: string }[] {
  const pages: { page: number | null; text: string }[] = [];
  let current: { page: number | null; lines: string[] } = { page: null, lines: [] };
  for (const line of text.split("\n")) {
    const m = PAGE_MARK.exec(line.trim());
    if (m) {
      if (current.lines.join("").trim()) pages.push({ page: current.page, text: current.lines.join("\n").trim() });
      current = { page: Number(m[1]), lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.join("").trim()) pages.push({ page: current.page, text: current.lines.join("\n").trim() });
  return pages;
}

function sha(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
