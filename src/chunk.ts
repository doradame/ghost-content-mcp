// Structure-aware chunking: split a post/page HTML into heading-delimited sections, each a
// self-contained retrievable unit. "Respecting content" means we split on real headings
// (never mid-sentence), carry the heading + its Ghost-generated anchor id for deep-linking,
// and leave short/heading-less docs as a single chunk.

export interface Section {
  heading: string | null;      // section heading text (null = the intro before the first heading)
  headingPath: string | null;  // "Parent H2 › H3" for context
  anchor: string | null;       // heading id (from Ghost's HTML) → deep link url#anchor
  text: string;                // plaintext of the section, heading included
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const HEADING_RE = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;

/**
 * Split HTML into sections at every H2/H3. Returns [] when the doc has no such headings —
 * the caller then keeps the whole document as one chunk.
 */
export function splitIntoSections(html: string): Section[] {
  const heads: Array<{ level: number; start: number; end: number; attrs: string; inner: string }> = [];
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(html))) {
    heads.push({ level: +m[1], start: m.index, end: HEADING_RE.lastIndex, attrs: m[2], inner: m[3] });
  }
  if (heads.length === 0) return [];

  const sections: Section[] = [];

  // Intro before the first heading (e.g. a TL;DR / lede) is its own chunk.
  const preface = stripTags(html.slice(0, heads[0].start));
  if (preface) sections.push({ heading: null, headingPath: null, anchor: null, text: preface });

  let currentH2: string | null = null;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const headingText = stripTags(h.inner);
    if (!headingText) continue;
    const anchor = (h.attrs.match(/\bid="([^"]*)"/) || [])[1] || null;
    if (h.level === 2) currentH2 = headingText;
    const headingPath = h.level === 3 && currentH2 ? `${currentH2} › ${headingText}` : headingText;

    const bodyHtml = html.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : html.length);
    const body = stripTags(bodyHtml);
    // Keep the heading inside the chunk text so it's both searchable and readable as an excerpt.
    sections.push({ heading: headingText, headingPath, anchor, text: body ? `${headingText}. ${body}` : headingText });
  }
  return sections;
}
