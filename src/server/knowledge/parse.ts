import * as cheerio from "cheerio";

export interface ParsedPage {
  page: number | null;
  text: string;
}

export interface ParsedDocument {
  title: string | null;
  pages: ParsedPage[];
  /** Linked PDF documents found on an HTML page (offered to the admin as further sources). */
  linkedDocuments?: { url: string; label: string }[];
}

export async function parsePdf(buf: Buffer): Promise<ParsedDocument> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    const pages = result.pages.map((p) => ({ page: p.num, text: normalizeWhitespace(p.text) })).filter((p) => p.text);
    return { title: null, pages };
  } finally {
    await parser.destroy();
  }
}

export function parseText(buf: Buffer): ParsedDocument {
  return { title: null, pages: [{ page: null, text: normalizeWhitespace(buf.toString("utf8")) }] };
}

/**
 * Extracts the readable body of an HTML page as Markdown-ish text that preserves headings,
 * lists and FAQ structure (the chunker relies on headings to chunk semantically).
 */
export function parseHtml(html: string, baseUrl: string): ParsedDocument {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || null;
  $("script, style, noscript, svg, iframe, form, header, footer, nav").remove();
  $("[role='navigation'], .elementor-location-header, .elementor-location-footer, .menu, .sub-menu, [class*='menu-item'], [class*='mini-cart']")
    .not("html, body, main")
    .remove();

  const linkedDocuments: { url: string; label: string }[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (/\.pdf($|\?)/i.test(href)) {
      try {
        const url = new URL(href, baseUrl);
        if (url.protocol === "https:") linkedDocuments.push({ url: url.toString(), label: $(el).text().trim() || href });
      } catch {
        /* ignore malformed links */
      }
    }
  });

  const lines: string[] = [];
  const root = $("main").length ? $("main") : $("body");
  root.find("h1, h2, h3, h4, h5, h6, p, li, summary, dt, dd, .elementor-tab-title, .elementor-tab-content").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    // Avoid duplicates from nested matches (e.g. <p> inside <li>).
    if ($(el).parents("li, p, dd").length > 0 && tag !== "li") return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (/^h[1-6]$/.test(tag)) lines.push(`\n${"#".repeat(Number(tag[1]))} ${text}`);
    else if ($(el).hasClass("elementor-tab-title")) lines.push(`\n### ${text}`);
    else if (tag === "li") lines.push(`- ${text}`);
    else lines.push(text);
  });

  const deduped: string[] = [];
  for (const line of lines) if (deduped[deduped.length - 1] !== line) deduped.push(line);
  // Page builders sometimes put content in plain <div>s: fall back to the visible body text.
  if (deduped.join(" ").length < 200) {
    const fallback = root.text().replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    if (fallback.length > deduped.join(" ").length) deduped.splice(0, deduped.length, fallback);
  }
  const uniqueDocs = [...new Map(linkedDocuments.map((d) => [d.url, d])).values()];
  return { title, pages: [{ page: null, text: normalizeWhitespace(deduped.join("\n")) }], linkedDocuments: uniqueDocs };
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
