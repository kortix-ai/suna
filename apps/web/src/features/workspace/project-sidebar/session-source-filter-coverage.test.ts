/**
 * Every session source the filter menu OFFERS must have an icon and a label.
 *
 * `SESSION_SOURCE_FILTERS` gained `teams` (f5ed68a690) and neither map in
 * `session-filter-menu.tsx` did. The menu renders
 * `const OptionIcon = SOURCE_FILTER_ICONS[option.value]` and then
 * `<OptionIcon />` — so the missing key rendered `undefined`, React threw
 * "Element type is invalid", and the error boundary took down the whole
 * project page. Not the menu: the page.
 *
 * Both maps are `Record<SessionSourceFilter, …>`, so `tsc` reported this as two
 * TS2741 errors from the moment it merged. Nobody was listening:
 * `apps/web/next.config.ts` sets `typescript.ignoreBuildErrors: true` on the
 * claim that typechecking happens "in CI via pnpm typecheck", and no CI job
 * typechecks apps/web. A type error that crashes at runtime can merge green.
 *
 * This test runs in the lane that DOES gate apps/web — its unit tests — so the
 * next source added without its chrome fails something that is actually read.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SESSION_SOURCE_FILTERS } from '@/components/projects/session-label';

const menuSource = readFileSync(resolve(import.meta.dir, 'session-filter-menu.tsx'), 'utf8');

/** The keys of the object literal assigned to `name`, by brace matching so the
 *  scan stops at THIS literal's close and not a later one. */
function mapKeys(name: string): string[] {
  const start = menuSource.indexOf(name);
  if (start === -1) throw new Error(`${name} not found`);
  // Anchor on the ASSIGNMENT: the first `{` after the name belongs to the type
  // annotation (`ComponentType<{ className?: string }>`), not the literal.
  const assign = menuSource.indexOf('= {', start);
  if (assign === -1) throw new Error(`${name} is not an object literal`);
  const open = assign + 2;
  let depth = 0;
  let close = -1;
  for (let i = open; i < menuSource.length; i += 1) {
    if (menuSource[i] === '{') depth += 1;
    else if (menuSource[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`${name} literal is unterminated`);
  return [...menuSource.slice(open, close).matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
}

describe('the filter menu can render every source it offers', () => {
  const offered = SESSION_SOURCE_FILTERS.map((f) => f.value).sort();

  test('teams is offered — the regression that crashed the project page', () => {
    expect(offered).toContain('teams');
  });

  test('every offered source has an icon', () => {
    expect(mapKeys('SOURCE_FILTER_ICONS').sort()).toEqual(offered);
  });

  test('every offered source has a label', () => {
    expect(mapKeys('const sourceLabels').sort()).toEqual(offered);
  });
});
