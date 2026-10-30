import { describe, expect, test } from 'bun:test';

import { pageAttachment, pageFileName, pageMarkdown, screenshotAttachment, sendTabs, withActTab, withQuote } from './panel-prompt';

const page = { tabId: 4, title: 'Pricing — Northwind', url: 'https://northwind.example.com/pricing', text: 'Team $29', truncated: false };
const tab = (id: number, title = `Tab ${id}`) => ({ id, title, url: `https://example.com/${id}`, readable: true });
const readAt = new Date('2026-10-27T16:00:00.000Z');

describe('panel prompt', () => {
  test('a page file is named after the title, without path or reserved characters', () => {
    expect(pageFileName('Pricing — Northwind')).toBe('Pricing — Northwind.md');
    expect(pageFileName('a/b\\c: "d" <e>|f?*')).toBe('a b c d e f.md');
    expect(pageFileName('   ')).toBe('page.md');
    expect(pageFileName('x'.repeat(200))).toBe(`${'x'.repeat(80)}.md`);
  });

  test('the page file carries the title, address, read time and text', () => {
    const md = pageMarkdown(page, readAt);
    expect(md).toContain('# Pricing — Northwind');
    expect(md).toContain('Source: https://northwind.example.com/pricing');
    expect(md).toContain('2026-10-27T16:00:00.000Z');
    expect(md).toContain('Team $29');
    expect(md).not.toContain('longer');
    expect(pageMarkdown({ ...page, truncated: true }, readAt)).toContain('The page is longer');
  });

  test('a read page becomes a local Markdown attachment', async () => {
    const file = pageAttachment(page, readAt);
    expect(file.kind).toBe('local');
    if (file.kind !== 'local') return;
    expect(file.file.name).toBe('Pricing — Northwind.md');
    expect(file.file.type).toBe('text/markdown');
    expect(file.isImage).toBe(false);
    expect(await file.file.text()).toBe(pageMarkdown(page, readAt));
  });

  test('a screenshot becomes a JPEG image attachment named after the page', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const dataUrl = `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
    const shot = screenshotAttachment(dataUrl, 'Pricing — Northwind', readAt);
    expect(shot.kind).toBe('local');
    if (shot.kind !== 'local') return;
    expect(shot.isImage).toBe(true);
    expect(shot.file.name).toBe('Pricing — Northwind screenshot.jpg');
    expect(shot.file.type).toBe('image/jpeg');
    expect(new Uint8Array(await shot.file.arrayBuffer())).toEqual(bytes);
    expect(() => screenshotAttachment('data:text/html;base64,PGI+', 'x', readAt)).toThrow();
  });

  test('a quote goes under the message, with its source', () => {
    expect(withQuote('Is SCIM included?', 'Business includes SCIM.\nAnd SSO.', tab(4, 'Pricing'))).toBe(
      'Is SCIM included?\n\nSelected text from “Pricing” (https://example.com/4):\n> Business includes SCIM.\n> And SSO.',
    );
    expect(withQuote('Why?', 'A line', null)).toBe('Why?\n\nSelected text:\n> A line');
  });

  test('Act names the tab the agent starts in', () => {
    expect(withActTab('Start a trial.', tab(4, 'Pricing'))).toBe(
      'Start a trial.\n\nUse my Chrome for this. Start in my open tab “Pricing” (https://example.com/4).',
    );
  });

  test('the followed active tab comes first, every tab once', () => {
    expect(sendTabs(tab(1), true, [tab(2), tab(1)]).map((t) => t.id)).toEqual([1, 2]);
    expect(sendTabs(tab(1), false, [tab(2)]).map((t) => t.id)).toEqual([2]);
    expect(sendTabs(null, true, []).map((t) => t.id)).toEqual([]);
  });
});
