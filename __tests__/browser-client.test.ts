/**
 * Unit tests for the Markdown -> Medium editor HTML conversion.
 * These assert the quirks Medium's paste handler imposes, discovered empirically
 * against medium.com (2026) and corroborated by independent publishers.
 */
import { BrowserMediumClient } from '../src/browser-client';

const client = new BrowserMediumClient();

// markdownToEditorHtml is private in TS but callable at runtime.
const toHtml = (md: string): Promise<string> =>
  (client as any).markdownToEditorHtml(md);

describe('markdownToEditorHtml', () => {
  it('converts markdown headings to HTML headings', async () => {
    const html = await toHtml('## Section title');
    expect(html).toContain('<h2>Section title</h2>');
  });

  it('keeps a fenced code block as ONE <pre> block', async () => {
    const md = '```ts\nconst a = 1;\n\nconst b = 2;\n```';
    const html = await toHtml(md);
    expect((html.match(/<pre>/g) || []).length).toBe(1);
    expect((html.match(/<\/pre>/g) || []).length).toBe(1);
  });

  it('collapses blank lines inside a code block (Medium splits them otherwise)', async () => {
    const md = '```\nline one\n\nline two\n```';
    const html = await toHtml(md);
    const pre = html.slice(html.indexOf('<pre>'), html.indexOf('</pre>'));
    expect(pre).not.toMatch(/\n\n/);
  });

  it('flattens a blockquote so it does not render as empty quote blocks', async () => {
    const html = await toHtml('> a quoted line');
    expect(html).toContain('<blockquote>');
    expect(html).not.toMatch(/<blockquote>\s*<p>/);
  });

  it('converts tables to a bullet list (Medium has no table model)', async () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = await toHtml(md);
    expect(html).not.toContain('<table>');
    expect(html).toContain('- 1 - 2');
  });

  it('preserves lists and inline formatting', async () => {
    const html = await toHtml('- first\n- second\n\n**bold** and `code`');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });
});
