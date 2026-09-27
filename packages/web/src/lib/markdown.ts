// A deliberately tiny markdown subset for the LLM session summary (docs/web.md §3 Recap). Parsing
// produces plain data; `SummaryMarkdown.tsx` renders it with React elements, so nothing here is
// ever HTML and there is no `dangerouslySetInnerHTML` anywhere. Supported: `## ` / `### `
// headings, `- ` bullets (one level), `**bold**`, `_italic_` / `*italic*`, paragraphs. Everything
// else (links, code, tables, `#`, numbered lists, HTML) is shown as the literal text it is.

export interface Span {
  text: string;
  bold?: true;
  italic?: true;
}

export type Block =
  | { type: 'h2'; spans: Span[] }
  | { type: 'h3'; spans: Span[] }
  | { type: 'ul'; items: Span[][] }
  | { type: 'p'; spans: Span[] };

// `**bold**` first, then `*italic*`, then `_italic_` only at word edges (so snake_case and
// file_names stay literal). Non-greedy, single line, no nesting.
const INLINE_RE = /\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_]+?)_(?![A-Za-z0-9])/g;

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index;
    if (start > last) spans.push({ text: text.slice(last, start) });
    if (m[1] !== undefined) spans.push({ text: m[1], bold: true });
    else spans.push({ text: m[2] ?? m[3] ?? '', italic: true });
    last = start + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

const BULLET_RE = /^\s*[-*]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Span[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: 'p', spans: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list !== null && list.length > 0) blocks.push({ type: 'ul', items: list });
    list = null;
  };

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (line.startsWith('### ')) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'h3', spans: parseInline(line.slice(4).trim()) });
      continue;
    }
    if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'h2', spans: parseInline(line.slice(3).trim()) });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet !== null) {
      flushParagraph();
      list ??= [];
      list.push(parseInline((bullet[1] ?? '').trim()));
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
