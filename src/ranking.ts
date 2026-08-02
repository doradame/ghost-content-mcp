// Pure lexical ranking: tokenizer + BM25. No I/O, fully unit-testable.

export const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with', 'is', 'are',
  'at', 'by', 'it', 'this', 'that', 'these', 'those', 'as', 'be', 'from', 'how', 'what',
  'do', 'does', 'did', 'you', 'your', 'i', 'we', 'our', 'can', 'about', 'me', 'my',
  'so', 'if', 'not', 'no', 'yes', 'all', 'any', 'was', 'were', 'have', 'has', 'had',
]);

/** Lowercase, split on non-alphanumerics, drop very short tokens and stopwords. */
export function tokenize(s: string): string[] {
  const raw = (s || '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return raw.filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export interface Bm25Doc {
  id: string;
  tokens: string[];
}

/** Okapi BM25 over a small in-memory corpus. */
export class Bm25 {
  private readonly idf = new Map<string, number>();
  private readonly tf: Array<Map<string, number>> = [];
  private readonly ids: string[] = [];
  private readonly len: number[] = [];
  private avgdl = 0;

  constructor(docs: Bm25Doc[], private readonly k1 = 1.5, private readonly b = 0.75) {
    const df = new Map<string, number>();
    let totalLen = 0;
    for (const doc of docs) {
      const counts = new Map<string, number>();
      for (const t of doc.tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.tf.push(counts);
      this.ids.push(doc.id);
      this.len.push(doc.tokens.length);
      totalLen += doc.tokens.length;
      for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const N = docs.length || 1;
    this.avgdl = totalLen / N;
    for (const [term, n] of df) {
      // BM25 idf with +1 smoothing so it stays non-negative for common terms
      this.idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }
  }

  /** Returns id → raw BM25 score for docs that match at least one query term. */
  score(queryTokens: string[]): Map<string, number> {
    const q = [...new Set(queryTokens)];
    const out = new Map<string, number>();
    for (let i = 0; i < this.ids.length; i++) {
      const counts = this.tf[i];
      const dl = this.len[i] || 1;
      let s = 0;
      for (const term of q) {
        const f = counts.get(term);
        if (!f) continue;
        const idf = this.idf.get(term) ?? 0;
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * dl) / this.avgdl)));
      }
      if (s > 0) out.set(this.ids[i], s);
    }
    return out;
  }
}

/** Dot product of two L2-normalized vectors == cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

/** Jaccard-ish overlap of two tag sets, 0..1. */
export function tagOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b.map((t) => t.toLowerCase()));
  let hit = 0;
  for (const t of a) if (sb.has(t.toLowerCase())) hit++;
  const union = new Set([...a, ...b].map((t) => t.toLowerCase())).size;
  return union ? hit / union : 0;
}
