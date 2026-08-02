import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/markdown.js';

describe('htmlToMarkdown', () => {
  it('converts headings, links and code to markdown', () => {
    const html =
      '<h2>Setup</h2><p>Install <a href="https://example.com">the tool</a>.</p>' +
      '<pre><code>apt install foo</code></pre>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('## Setup');
    expect(md).toContain('[the tool](https://example.com)');
    expect(md).toContain('```\napt install foo\n```');
  });

  it('drops script and style tags entirely', () => {
    const html = '<p>Visible</p><script>alert(1)</script><style>.x{color:red}</style>';
    const md = htmlToMarkdown(html);
    expect(md).toBe('Visible');
  });

  it('returns empty string for empty/nullish input', () => {
    expect(htmlToMarkdown('')).toBe('');
  });
});
