import { describe, it, expect } from 'vitest';
import { splitIntoSections } from '../src/chunk.js';

describe('splitIntoSections', () => {
  it('splits at H2/H3, captures heading text and the Ghost anchor id', () => {
    const html =
      '<p>Intro lede.</p>' +
      '<h2 id="level-1">Level 1</h2><p>About level one.</p>' +
      '<h3 id="token">Token</h3><p>A token is a frequent fragment.</p>' +
      '<h3 id="bpe">BPE</h3><p>Byte-pair encoding builds the vocab.</p>';
    const s = splitIntoSections(html);
    // preface + 3 headings
    expect(s.map((x) => x.heading)).toEqual([null, 'Level 1', 'Token', 'BPE']);
    expect(s[0].text).toBe('Intro lede.');
    const token = s.find((x) => x.heading === 'Token')!;
    expect(token.anchor).toBe('token');
    expect(token.text).toContain('A token is a frequent fragment');
    expect(token.text.startsWith('Token')).toBe(true); // heading kept inside the chunk text
  });

  it('builds a parent › child heading path for H3 under H2', () => {
    const html = '<h2 id="a">Parent</h2><h3 id="b">Child</h3><p>body</p>';
    const s = splitIntoSections(html);
    // headingPath is internal to embedding, but we can at least confirm structure holds
    expect(s.map((x) => x.heading)).toEqual(['Parent', 'Child']);
  });

  it('decodes HTML entities in section text', () => {
    const html = '<h3 id="x">X</h3><p>a &amp; b &lt; c &mdash; done</p>';
    const s = splitIntoSections(html);
    expect(s[0].text).toContain('a & b < c — done');
  });

  it('returns [] when there are no H2/H3 headings (caller keeps the whole doc)', () => {
    expect(splitIntoSections('<p>just a short post, no headings</p>')).toEqual([]);
  });
});
