import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const briefSource = readFileSync(join(import.meta.dir, 'session-brief-hover-card.tsx'), 'utf8');
const scrollAreaSource = readFileSync(
  join(import.meta.dir, '../../../components/ui/faded-scroll-area.tsx'),
  'utf8',
);

describe('session brief hover card portal', () => {
  test('escapes the sidebar scroll container', () => {
    expect(scrollAreaSource).toContain('overflow-y-auto');

    const popoverContent = briefSource.slice(
      briefSource.indexOf('<PopoverContent'),
      briefSource.indexOf('</PopoverContent>'),
    );
    expect(popoverContent).not.toContain('container=');
  });
});
