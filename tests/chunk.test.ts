import { describe, expect, it } from "vitest";
import { chunkDocument } from "@/server/knowledge/chunk";
import { deserializePages, serializePages } from "@/server/knowledge/sources";
import { parseHtml } from "@/server/knowledge/parse";
import { sniffKind } from "@/lib/storage";
import { toOrTsQuery } from "@/server/knowledge/retrieve";

describe("semantic chunking", () => {
  it("keeps procedure steps together and attaches warnings to them", () => {
    const text = `# Indications
Some intro text about indications.

# Procedure
1. Wet the scaffold.
2. Trim to fit the defect.
3. Place after debridement.
4. Close the site.
Warning: do not use in infected sites without debridement.

# Storage
Store dry at room temperature.`;
    const chunks = chunkDocument([{ page: 2, text }]);
    const proc = chunks.find((c) => c.section === "Procedure")!;
    expect(proc.content).toMatch(/1\. Wet[\s\S]*4\. Close/);
    expect(proc.content).toMatch(/Warning: do not use/);
    expect(proc.page).toBe(2);
    expect(chunks.find((c) => c.section === "Storage")?.content).toBe("Store dry at room temperature.");
  });

  it("does not treat upper-case warnings as section headings", () => {
    const chunks = chunkDocument([{ page: 1, text: "# Procedure\n1. Place the scaffold.\n2. Close.\nDO NOT RESTERILIZE" }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe("Procedure");
    expect(chunks[0].content).toContain("DO NOT RESTERILIZE");
  });

  it("round-trips page markers", () => {
    const s = serializePages({ title: null, pages: [{ page: 1, text: "a" }, { page: 2, text: "b" }] })!;
    expect(deserializePages(s)).toEqual([{ page: 1, text: "a" }, { page: 2, text: "b" }]);
  });

  it("extracts headed text and linked PDFs from HTML", () => {
    const doc = parseHtml(`<html><body><nav>Menu</nav><main><h2>FAQ</h2><p>Answer one.</p><a href="/x/study.pdf">Study</a></main></body></html>`, "https://biochange.life/page/");
    expect(doc.pages[0].text).toContain("## FAQ");
    expect(doc.pages[0].text).not.toContain("Menu");
    expect(doc.linkedDocuments?.[0].url).toBe("https://biochange.life/x/study.pdf");
  });
});

describe("helpers", () => {
  it("identifies files by content, not name", () => {
    expect(sniffKind(Buffer.from("%PDF-1.7 ..."))).toBe("pdf");
    expect(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffKind(Buffer.from([0x4d, 0x5a, 0x00, 0x00]))).toBeNull(); // executable
    expect(sniffKind(Buffer.from("a".repeat(4095) + "– µm", "utf8"))).toBe("text"); // multibyte char across the 4 KB boundary
  });

  it("builds injection-safe OR queries", () => {
    expect(toOrTsQuery("What's the ReGum'); DROP TABLE x; -- protocol?")).toBe("regum | drop | table | protocol");
  });
});
