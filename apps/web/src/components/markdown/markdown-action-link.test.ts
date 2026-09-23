import { describe, expect, test } from 'bun:test';

import { classifyMarkdownActionLink, standaloneActionLinks } from './markdown-action-link';

describe('classifyMarkdownActionLink', () => {
  test('known connect host → connect, plug icon', () => {
    expect(
      classifyMarkdownActionLink(
        'https://connect.composio.dev/link/lk_debug',
        'Connect Shopify',
        null,
      ),
    ).toEqual({
      kind: 'connect',
      href: 'https://connect.composio.dev/link/lk_debug',
      label: 'Connect Shopify',
      host: 'connect.composio.dev',
      icon: 'plug',
    });
  });

  test('verb-rule connect on an unknown host', () => {
    const result = classifyMarkdownActionLink('https://example.com/oauth', 'Authorize Linear', null);
    expect(result?.kind).toBe('connect');
    expect(result?.icon).toBe('plug');
  });

  test('setup link path → setup kind', () => {
    const result = classifyMarkdownActionLink('/connect/ksl_debug_token', 'Connect Gmail', null);
    expect(result?.kind).toBe('setup');
    expect(result?.icon).toBe('plug');
    expect(result?.host).toBeNull();
  });

  test('internal root-relative link, files segment → folder icon', () => {
    expect(classifyMarkdownActionLink('/projects/p1/files', 'Open files', null)).toEqual({
      kind: 'internal',
      href: '/projects/p1/files',
      label: 'Open files',
      host: null,
      icon: 'folder',
    });
  });

  test('internal icon by pathname segment', () => {
    expect(classifyMarkdownActionLink('/projects/p1/settings', 'Settings', null)?.icon).toBe(
      'settings',
    );
    expect(classifyMarkdownActionLink('/projects/p1/connectors', 'Connectors', null)?.icon).toBe(
      'plug',
    );
    expect(classifyMarkdownActionLink('/search?q=x', 'Search', null)?.icon).toBe('search');
    expect(classifyMarkdownActionLink('/projects/p1/sessions/s1', 'Open chat', null)?.icon).toBe(
      'chat',
    );
    expect(classifyMarkdownActionLink('/projects/p1', 'Open project', null)?.icon).toBe(
      'arrow-right',
    );
  });

  test('same-origin absolute link → internal, folder icon', () => {
    expect(
      classifyMarkdownActionLink(
        'https://app.kortix.test/projects/p1/files',
        'Open files',
        'https://app.kortix.test',
      ),
    ).toEqual({
      kind: 'internal',
      href: 'https://app.kortix.test/projects/p1/files',
      label: 'Open files',
      host: 'app.kortix.test',
      icon: 'folder',
    });
  });

  test('cross-origin absolute link → external', () => {
    expect(
      classifyMarkdownActionLink('https://docs.example.com/guide', 'Read the guide', null),
    ).toEqual({
      kind: 'external',
      href: 'https://docs.example.com/guide',
      label: 'Read the guide',
      host: 'docs.example.com',
      icon: 'arrow-up-right',
    });
  });

  test('external link with a search label → search icon', () => {
    expect(
      classifyMarkdownActionLink('https://docs.example.com/guide', 'Search the docs', null)?.icon,
    ).toBe('search');
  });

  test('invalid hrefs are never actions', () => {
    expect(classifyMarkdownActionLink('#section', 'Jump', null)).toBeNull();
    expect(classifyMarkdownActionLink('mailto:a@example.com', 'Email us', null)).toBeNull();
    expect(classifyMarkdownActionLink('javascript:alert(1)', 'Run', null)).toBeNull();
    expect(classifyMarkdownActionLink('foo/bar', 'Relative', null)).toBeNull();
    expect(classifyMarkdownActionLink('http://:', 'Broken', null)).toBeNull();
    expect(classifyMarkdownActionLink('', 'Empty', null)).toBeNull();
  });

  test('bare-URL text is a reference, not an action', () => {
    expect(
      classifyMarkdownActionLink(
        'https://docs.example.com/guide',
        'https://docs.example.com/guide',
        null,
      ),
    ).toBeNull();
    expect(
      classifyMarkdownActionLink(
        'https://docs.example.com/guide',
        'https://docs.example.com/guide/',
        null,
      ),
    ).toBeNull();
  });

  test('label stripping removes leading/trailing glyphs and whitespace, collapses internal whitespace', () => {
    expect(
      classifyMarkdownActionLink(
        'https://connect.composio.dev/link/lk_debug',
        '→ Connect Shopify ↗',
        null,
      )?.label,
    ).toBe('Connect Shopify');
    expect(classifyMarkdownActionLink('/projects/p1/files', '->  Open   files', null)?.label).toBe(
      'Open files',
    );
    expect(classifyMarkdownActionLink('/projects/p1', '→', null)).toBeNull();
  });
});

describe('standaloneActionLinks', () => {
  const a = (href: string, text: string) => ({
    type: 'element',
    tagName: 'a',
    properties: { href },
    children: [{ type: 'text', value: text }],
  });
  const t = (value: string) => ({ type: 'text', value });
  const br = { type: 'element', tagName: 'br', properties: {}, children: [] };
  const p = (children: unknown[]) => ({ type: 'element', tagName: 'p', properties: {}, children });

  test('glyph text before a single link', () => {
    expect(standaloneActionLinks(p([t('→ '), a('/x', 'Go')]))).toEqual([
      { href: '/x', text: 'Go' },
    ]);
  });

  test('a single bare link', () => {
    expect(standaloneActionLinks(p([a('/x', 'Go')]))).toEqual([{ href: '/x', text: 'Go' }]);
  });

  test('two links separated by glyph text', () => {
    expect(standaloneActionLinks(p([a('/x', 'Go'), t('\n→ '), a('/y', 'Also')]))).toEqual([
      { href: '/x', text: 'Go' },
      { href: '/y', text: 'Also' },
    ]);
  });

  test('a strong-wrapped link counts as that link', () => {
    const strong = { type: 'element', tagName: 'strong', properties: {}, children: [a('/x', 'Go')] };
    expect(standaloneActionLinks(p([strong]))).toEqual([{ href: '/x', text: 'Go' }]);
  });

  test('prose text before a link is not standalone', () => {
    expect(standaloneActionLinks(p([t('See '), a('/x', 'Go')]))).toBeNull();
  });

  test('prose text after a link is not standalone', () => {
    expect(standaloneActionLinks(p([a('/x', 'Go'), t(' for details')]))).toBeNull();
  });

  test('a code element is never standalone', () => {
    expect(
      standaloneActionLinks(p([{ type: 'element', tagName: 'code', properties: {}, children: [] }])),
    ).toBeNull();
  });

  test('no children yields null', () => {
    expect(standaloneActionLinks(p([]))).toBeNull();
  });

  test('a br between two links does not break the block', () => {
    expect(standaloneActionLinks(p([a('/x', 'Go'), br, a('/y', 'Also')]))).toEqual([
      { href: '/x', text: 'Go' },
      { href: '/y', text: 'Also' },
    ]);
  });
});
