// Every `<Card>` in the docs shows a glyph.
//
// The cards on /docs rendered as eight identical blocks of text: each one
// carries an `href` and none carried an `icon`, so the tile fumadocs reserves
// for one (`fumadocs-ui/dist/components/card.js`) stayed empty and the grid
// read as a wall.
//
// The check is on the CONTENT, not on a component, and that is deliberate.
// Every page imports `Card` by name, so a default supplied through the MDX
// components map would never reach it — an override there type-checks, renders
// nothing different, and looks correct in review. What the page actually
// renders is decided by the prop in the file.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DOCS = import.meta.dir;

function mdxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return mdxFiles(path);
    return entry.isFile() && entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** Every `<Card …>` opening tag in the docs, with the file it came from. */
const cards = mdxFiles(DOCS).flatMap((path) => {
  const source = readFileSync(path, 'utf8');
  return (source.match(/<Card\b[^>]*>/g) ?? []).map((tag) => ({
    file: path.slice(DOCS.length + 1),
    tag,
  }));
});

describe('docs cards', () => {
  test('there are cards to check', () => {
    // A regex that silently matched nothing would make every assertion below
    // pass on an empty list.
    expect(cards.length).toBeGreaterThan(20);
  });

  test('every card carries an icon', () => {
    const bare = cards.filter((c) => !c.tag.includes('icon=')).map((c) => `${c.file}: ${c.tag}`);

    expect(bare).toEqual([]);
  });

  test('every icon comes from the app SSR set, and the file imports it', () => {
    // Two failures this catches, both of which render as a broken page rather
    // than a broken build: an icon used without its import, and an icon taken
    // from `@phosphor-icons/react` directly — whose main entry calls
    // `createContext` at module scope and crashes a server component.
    for (const path of mdxFiles(DOCS)) {
      const source = readFileSync(path, 'utf8');
      const used = new Set(
        [...source.matchAll(/<Card\b[^>]*\bicon=\{<(\w+)\s*\/>\}/g)].map((m) => m[1]),
      );
      if (used.size === 0) continue;

      const importBlock = /import\s*\{([^}]+)\}\s*from\s*'@\/lib\/icons\/ssr';/.exec(source);
      expect(
        importBlock,
        `${path} uses icons but imports none from @/lib/icons/ssr`,
      ).not.toBeNull();

      const imported = new Set(importBlock![1].split(',').map((name) => name.trim()));
      for (const name of used) {
        expect(imported.has(name), `${path} uses <${name} /> without importing it`).toBe(true);
      }
    }
  });

  test('cards come from the local component, not from fumadocs', () => {
    // `docs-card.tsx` is what puts the glyph on the title's line without a
    // tile around it. Fumadocs' own card hardcodes the opposite —
    // `w-fit shadow-md rounded-lg border bg-fd-muted p-1.5`, stacked above the
    // title — and nothing reaches those classes from the outside, so importing
    // it again silently restores the boxed mark.
    for (const path of mdxFiles(DOCS)) {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('<Card')) continue;

      expect(source, `${path} imports the card from fumadocs`).not.toContain(
        "from 'fumadocs-ui/components/card'",
      );
      expect(source, `${path} renders cards without importing them`).toContain(
        "from '@/components/markdown/docs-card'",
      );
    }
  });
});
