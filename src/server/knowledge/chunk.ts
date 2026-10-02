import type { ParsedPage } from "./parse";

export interface Chunk {
  content: string;
  section: string | null;
  page: number | null;
}

const TARGET_WORDS = 350;
const MAX_WORDS = 650;

const HEADING = /^(#{1,6})\s+(.+)$/;
// Upper-case or numbered section titles typical of IFUs and papers ("INDICATIONS", "3. Method").
const PLAIN_HEADING = /^(?:\d+(?:\.\d+)*\.?\s+)?[A-Z][A-Z0-9 ,&/()\-]{3,60}$/;
const STEP = /^\s*(?:\d+[.)]|step\s+\d+|[-•*])\s+/i;
const QUALIFIER = /^\s*(?:warning|caution|important|note|precaution|contraindication|do not)\b/i;

interface Block {
  text: string;
  section: string | null;
  page: number | null;
  kind: "steps" | "qualifier" | "text";
}

/**
 * Semantic chunker:
 *  - splits on headings so a chunk belongs to one section,
 *  - keeps consecutive numbered/bulleted procedure steps together,
 *  - attaches warnings/cautions to the block they qualify instead of separating them,
 *  - then packs blocks of the same section up to a target size.
 */
export function chunkDocument(pages: ParsedPage[]): Chunk[] {
  const blocks = toBlocks(pages);
  const chunks: Chunk[] = [];
  let current: Block[] = [];

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      content: current.map((b) => b.text).join("\n\n"),
      section: current[0].section,
      page: current[0].page,
    });
    current = [];
  };

  for (const block of blocks) {
    const size = words(current.map((b) => b.text).join(" "));
    const sameSection = current.length === 0 || current[0].section === block.section;
    const fits = size + words(block.text) <= (block.kind === "qualifier" ? MAX_WORDS * 1.5 : MAX_WORDS);
    // Qualifiers always stay with the preceding block when it is in the same section.
    if (block.kind === "qualifier" && current.length && sameSection) {
      current.push(block);
      continue;
    }
    if (!sameSection || !fits || size >= TARGET_WORDS) flush();
    current.push(block);
  }
  flush();

  // Very long single blocks (e.g. an unbroken PDF page) are split at sentence boundaries.
  return chunks.flatMap((c) => (words(c.content) > MAX_WORDS * 1.6 ? splitLong(c) : [c]));
}

function toBlocks(pages: ParsedPage[]): Block[] {
  const blocks: Block[] = [];
  let section: string | null = null;

  for (const { page, text } of pages) {
    const paragraphs = text.split(/\n{2,}|\n(?=#{1,6}\s)/);
    for (const para of paragraphs) {
      const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
      let buffer: string[] = [];
      let bufferKind: Block["kind"] = "text";
      const push = () => {
        if (buffer.length) blocks.push({ text: buffer.join("\n"), section, page, kind: bufferKind });
        buffer = [];
        bufferKind = "text";
      };
      for (const line of lines) {
        const h = HEADING.exec(line);
        if (h || (PLAIN_HEADING.test(line) && line.split(" ").length <= 8 && !STEP.test(line))) {
          push();
          section = (h ? h[2] : line).trim().slice(0, 160);
          continue;
        }
        const kind: Block["kind"] = STEP.test(line) ? "steps" : QUALIFIER.test(line) ? "qualifier" : "text";
        if (kind === "steps") {
          if (bufferKind !== "steps") push();
          bufferKind = "steps";
          buffer.push(line);
        } else if (kind === "qualifier") {
          push();
          blocks.push({ text: line, section, page, kind: "qualifier" });
        } else {
          if (bufferKind === "steps" && /^[a-z(]/.test(line)) {
            // continuation of a wrapped step line
            buffer[buffer.length - 1] += ` ${line}`;
            continue;
          }
          if (bufferKind === "steps") push();
          buffer.push(line);
        }
      }
      push();
    }
  }
  return blocks;
}

function splitLong(chunk: Chunk): Chunk[] {
  const sentences = chunk.content.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  const out: Chunk[] = [];
  let buf: string[] = [];
  for (const s of sentences) {
    buf.push(s);
    if (words(buf.join(" ")) >= TARGET_WORDS) {
      out.push({ ...chunk, content: buf.join(" ") });
      buf = [];
    }
  }
  if (buf.length) out.push({ ...chunk, content: buf.join(" ") });
  return out;
}

function words(s: string): number {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}
