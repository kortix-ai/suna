import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import { parseFrontmatter } from './markdown-frontmatter';

// Frontmatter is not decoration — if it is not lifted out BEFORE the markdown
// parser sees it, the block is read as prose: the opening `---` becomes a
// thematic break and the closing `---` turns everything above it into a setext
// <h2>. That is why an agent file rendered as one giant bold paragraph under a
// stray horizontal rule instead of a metadata card.

const AGENT_FILE = `---
description: Veyris internal admin & build agent. Full access.
mode: primary
permission:
  "*": allow
  edit: ask
---

You are **Veyris Internal**.

## When to use this agent
- Editing project config
`;

describe('parseFrontmatter', () => {
  test('lifts the block out so the body never reaches the markdown parser', () => {
    const { frontmatter, body } = parseFrontmatter(AGENT_FILE);

    expect(frontmatter).not.toBeNull();
    // The `---` fences must be gone. Leave either one in and the body renders
    // as a rule plus a setext heading.
    expect(body).not.toContain('---');
    expect(body).not.toContain('description:');
    expect(body.trim().startsWith('You are')).toBe(true);
  });

  test('reads flat scalar keys', () => {
    const { frontmatter } = parseFrontmatter(AGENT_FILE);

    expect(frontmatter?.mode).toBe('primary');
    expect(frontmatter?.description).toBe(
      'Veyris internal admin & build agent. Full access.',
    );
  });

  test('keeps a QUOTED nested key — `"*": allow` is the opencode permission idiom', () => {
    // The nested matcher only accepted [\w.-]+, so `"*"` fell through, the
    // parent stayed an empty object, and the card printed a bare em-dash where
    // the permissions should have been.
    const { frontmatter } = parseFrontmatter(AGENT_FILE);

    expect(frontmatter?.permission).toEqual({ '*': 'allow', edit: 'ask' });
  });

  test('a wildcard-only permission block does not collapse to an em-dash', () => {
    const { frontmatter } = parseFrontmatter('---\npermission:\n  "*": allow\n---\nbody\n');

    expect(frontmatter?.permission).toEqual({ '*': 'allow' });
  });

  test('content with no frontmatter passes through untouched', () => {
    const plain = '# Title\n\nSome prose.\n';
    expect(parseFrontmatter(plain)).toEqual({ frontmatter: null, body: plain });
  });

  test('a horizontal rule in the body is not mistaken for frontmatter', () => {
    // Only a block at the very START is frontmatter. A `---` further down is a
    // rule, and eating it would silently delete the author's content.
    const withRule = '# Title\n\n---\n\nAfter the rule.\n';
    const { frontmatter, body } = parseFrontmatter(withRule);

    expect(frontmatter).toBeNull();
    expect(body).toBe(withRule);
  });
});

// Regression guard for the whole class of bug, not just the one instance.
// Every surface that renders a markdown FILE has to split frontmatter off
// first; each one that forgets reproduces the same giant-heading rendering.
// Listing them here means the next renderer added to this set fails loudly
// instead of shipping the bug again.
describe('markdown FILE renderers all strip frontmatter', () => {
  const FILE_RENDERERS = [
    '../../features/session/action-panel/easy/file-viewer.tsx',
    '../../features/file-renderers/show-content-renderer.tsx',
    '../../features/file-viewer/file-content-renderer.tsx',
  ];

  for (const rel of FILE_RENDERERS) {
    test(`${rel.split('/').pop()} splits frontmatter before rendering`, () => {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      // Either it parses the block itself, or it delegates to the wrapper that
      // does. Both are correct; passing the raw file to a markdown parser is not.
      expect(source).toMatch(/parseFrontmatter|MarkdownWithFrontmatter/);
    });
  }
});
