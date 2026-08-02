import { describe, it, expect } from 'vitest';
import { tokenize, Bm25, tagOverlap, cosine } from '../src/ranking.js';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and 1-char tokens', () => {
    expect(tokenize('How do I secure a Docker container?')).toEqual(['secure', 'docker', 'container']);
  });
  it('keeps alphanumerics like cve ids', () => {
    expect(tokenize('CVE-2026-26980 incident')).toEqual(['cve', '2026', '26980', 'incident']);
  });
});

describe('Bm25', () => {
  const docs = [
    { id: 'a', tokens: tokenize('docker security hardening containers') },
    { id: 'b', tokens: tokenize('python data science pandas') },
    { id: 'c', tokens: tokenize('docker compose networking guide') },
  ];
  const bm = new Bm25(docs);

  it('ranks documents containing the query terms', () => {
    const scores = bm.score(tokenize('docker security'));
    expect(scores.has('a')).toBe(true);
    expect(scores.has('c')).toBe(true);
    expect(scores.has('b')).toBe(false);
    // 'a' matches both terms, 'c' only 'docker' → a scores higher
    expect(scores.get('a')!).toBeGreaterThan(scores.get('c')!);
  });

  it('returns no scores when nothing matches', () => {
    expect(bm.score(tokenize('kubernetes helm')).size).toBe(0);
  });
});

describe('cosine', () => {
  it('is 1 for identical unit vectors and 0 for orthogonal', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, b)).toBeCloseTo(0);
  });
});

describe('tagOverlap', () => {
  it('is 1 for identical tag sets and 0 for disjoint', () => {
    expect(tagOverlap(['Docker'], ['docker'])).toBeCloseTo(1);
    expect(tagOverlap(['Docker'], ['Python'])).toBe(0);
  });
  it('is fractional for partial overlap', () => {
    expect(tagOverlap(['Docker', 'Linux'], ['Docker', 'Python'])).toBeCloseTo(1 / 3);
  });
});
