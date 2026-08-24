import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./session-changes-indicator.tsx', import.meta.url)),
  'utf8',
);
const shared = readFileSync(
  fileURLToPath(new URL('../session-changes-shared.tsx', import.meta.url)),
  'utf8',
);

// Source-text assertions silently stop being able to fail when the file moves
// or the read returns ''. Pin the fixtures first so every test below is real.
describe('fixtures', () => {
  test('both sources are loaded and are the files under test', () => {
    expect(source).toContain('export function SessionChangesIndicator');
    expect(shared).toContain('export const CHANGE_STATUS_META');
  });
});

describe('SessionChangesIndicator — reads without knowing git', () => {
  test('drops the A / M / D shorthand for a tone plus a plain word', () => {
    expect(shared).not.toContain("letter: 'A'");
    expect(shared).not.toContain('CHANGE_STATUS_BADGE');
    expect(shared).toContain("modified: { tone: 'warning', label: 'Edited' }");
    expect(shared).toContain("deleted: { tone: 'destructive', label: 'Removed' }");

    expect(source).not.toContain('badge.letter');
    expect(source).toContain('STATUS_DOT[meta.tone]');
    // Color alone is not a label — the word rides along for screen readers.
    expect(source).toContain('<span className="sr-only">{meta.label}</span>');
  });

  test('states the destination once, as a Badge, never as mono text mid-sentence', () => {
    // `${baseRef}` in the aria-label template is not a rendered repetition —
    // count only the JSX expressions.
    const jsxBaseRefs = source.match(/(?<!\$)\{baseRef\}/g) ?? [];
    expect(jsxBaseRefs).toHaveLength(1);

    const badgeStart = source.indexOf('<Badge variant="outline"');
    expect(badgeStart).toBeGreaterThan(-1);
    const badge = source.slice(badgeStart, source.indexOf('</Badge>', badgeStart));
    expect(badge).toContain('{baseRef}');
    expect(badge).toContain('truncate');

    // The three "not in <base> version yet" repetitions and their mono spans
    // are gone; nothing this popover RENDERS is styled as code any more.
    // Scoped to the JSX so the file's own doc comment can still say why.
    const jsx = source.slice(source.indexOf('  return ('));
    expect(jsx).not.toContain('font-mono');
    expect(jsx).not.toContain('version yet');
    expect(jsx).not.toContain('separate version of');
  });

  test('the trigger is a status dot, not a number to read', () => {
    expect(source).toContain('<Hint side="bottom" sideOffset={4} delayDuration={300}');
    expect(source).toContain('bg-kortix-yellow ring-background');
    expect(source).toContain('size-2 rounded-full ring-2');
    // The count belongs in the popover title, not stacked on a 32px button.
    expect(source).not.toContain('size="tabular"');
    expect(source).not.toContain("'99+'");
  });

  test('the popover header is one fact and one route, aligned on a single row', () => {
    const headerStart = source.indexOf('<PopoverContent');
    const header = source.slice(headerStart, source.indexOf('<FadedScrollArea', headerStart));

    // Tile, title and route line sit in one centred row.
    expect(header).toContain('flex items-center gap-3 border-b');
    expect(header).toContain('bg-kortix-yellow/10 text-kortix-yellow');
    expect(header).toContain('size-9 shrink-0 items-center justify-center rounded-sm');

    // Exactly two lines of copy: the count, then where it goes.
    expect(header).toContain('{fileWord} changed');
    expect(header).toContain('In this session');
    expect(header).toContain('<ArrowRightIcon');
    expect(header).toContain('<span className="sr-only">to</span>');

    // The paragraph that repeated the first two lines is gone.
    expect(header).not.toContain('<p className="text-muted-foreground mt-2.5');
    expect(header.match(/<p /g) ?? []).toHaveLength(1);
  });

  test('ranks the two actions instead of giving them equal weight', () => {
    expect(source).not.toContain('grid-cols-2');
    const footerStart = source.lastIndexOf('border-t');
    const footer = source.slice(footerStart);
    const viewIndex = footer.indexOf('ViewChangesaf192a3b');
    const proposeIndex = footer.indexOf('OpenChangedc3b8624');
    expect(viewIndex).toBeGreaterThan(-1);
    expect(proposeIndex).toBeGreaterThan(viewIndex);
    expect(footer.slice(0, viewIndex)).toContain('variant="ghost"');
  });

  test('keeps the shared query and the diff-targeted quick view', () => {
    expect(source).toContain('useSessionChanges()');
    expect(source).toContain("openSessionQuickView('files', 'chip', { changes: true })");
    expect(source).toContain('if (changedCount === 0) return null;');
  });
});
