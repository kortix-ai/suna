import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir);
const SOURCE = readFileSync(join(ROOT, 'catalog-card.tsx'), 'utf8');

/**
 * `CatalogCard`'s leading slot, pinned.
 *
 * This exists because the slot was once deleted from the component while three
 * call sites still passed `leading`, and **nothing caught it at runtime**:
 * React silently ignores a prop a component does not declare, so every
 * connector logo and command glyph simply stopped rendering with no error, no
 * warning, and no failing test. `tsc` did report it — as
 * `Property 'leading' does not exist on type 'IntrinsicAttributes &
 * CatalogCardProps'` — but that string is easy to wave off as the repo's known
 * React 19-vs-18 `IntrinsicAttributes` noise, and it was.
 *
 * So the contract is asserted here instead, where it cannot be mistaken for a
 * types-version artefact.
 */
describe('CatalogCard leading slot', () => {
  test('the prop is declared, and declared optional', () => {
    // Optional: Skills renders these cards with no tile by design. Required
    // would force it to invent a placeholder.
    expect(SOURCE).toContain('leading?: ReactNode;');
  });

  test('the prop is destructured and rendered, not merely accepted', () => {
    // A prop present in the interface but dropped from the function signature
    // typechecks clean and still renders nothing. Both halves are asserted.
    expect(SOURCE).toMatch(/export function CatalogCard\(\{\s*\n\s*leading,/);
    expect(SOURCE).toContain('{leading ? <span className="shrink-0">{leading}</span> : null}');
  });

  test('every card in the capabilities tree either passes leading or opts out', () => {
    // The real regression was an inconsistent half-migration: the prop was
    // removed from the component and from Skills, but Commands and Connectors
    // were left passing it into a void. This walks the actual call sites so a
    // future edit cannot leave that state again unnoticed.
    const callers = readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx$/.test(name) && !name.includes('.test.'))
      .filter((name) => readFileSync(join(ROOT, name), 'utf8').includes('<CatalogCard'));

    // Guards the walk itself: a glob that matches nothing would pass every
    // assertion below by vacuous truth.
    expect(callers.length).toBeGreaterThan(0);

    for (const name of callers) {
      const source = readFileSync(join(ROOT, name), 'utf8');
      const cards = source.match(/<CatalogCard/g) ?? [];
      const leadings = source.match(/leading=/g) ?? [];
      // Either every card in the file carries a tile, or none does. A file
      // where only some cards pass `leading` renders a ragged grid with the
      // text columns of different rows starting at different x positions.
      expect([0, cards.length]).toContain(leadings.length);
    }
  });
});
