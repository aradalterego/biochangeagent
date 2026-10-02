import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe Markdown renderer for assistant messages (no HTML passthrough).
 * Supports paragraphs, headings, ordered/unordered lists, **bold**, *italic*, `code`
 * and citation markers like [S1], rendered through `renderCitation`.
 */
export function Markdown({ text, renderCitation }: { text: string; renderCitation?: (label: string) => ReactNode }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  const inline = (s: string) => renderInline(s, renderCitation);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<h4 key={key++}>{inline(h[2])}</h4>);
      i++;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^\s*\d+[.)]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push(<ol key={key++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>);
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
      blocks.push(<ul key={key++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^\s*\d+[.)]\s+|^\s*[-*•]\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <div className="prose-chat">{blocks}</div>;
}

function renderInline(s: string, renderCitation?: (label: string) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[S\d+\](?:\s*\[S\d+\])*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[S")) {
      const labels = tok.match(/S\d+/g) ?? [];
      out.push(<Fragment key={k++}>{labels.map((l) => (renderCitation ? <Fragment key={l}>{renderCitation(l)}</Fragment> : `[${l}]`))}</Fragment>);
    } else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
