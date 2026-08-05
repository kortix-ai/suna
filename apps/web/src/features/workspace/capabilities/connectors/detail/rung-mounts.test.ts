import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONNECTOR_RUNG_ORDER, type ConnectorRung } from './connector-rungs';

const source = readFileSync(join(import.meta.dir, 'connector-modal.tsx'), 'utf8');

/**
 * Guards the one class of defect none of the other gates catch: a rung
 * component that is imported, exported, and independently tested — but never
 * actually mounted in `connector-modal.tsx`. `no-unused-vars` is off in this
 * repo and `noUnusedLocals` is unset, so deleting a JSX mount while leaving
 * its `import` in place trips neither eslint nor `tsc`. This is not
 * hypothetical: the entire connector surface went unreachable this way once
 * (an early pass), and the OAuth 2.0 return leg a second time (Task 7) — both
 * times the code underneath was correct and simply never wired into the
 * render tree.
 *
 * Milestone-wide, not Settings-specific: this file lives beside
 * `connector-rungs.test.ts` (which pins the ORDER) rather than beside
 * `rung-settings.write-path.test.ts` (which is one rung's write path), and it
 * is keyed off `CONNECTOR_RUNG_ORDER` itself rather than a literal list of
 * strings — a rung added to that order later with no matching entry in
 * `RUNG_COMPONENT` below fails LOUD on the first test, instead of the loop
 * silently iterating zero times for the missing entry.
 */
const RUNG_COMPONENT: Record<ConnectorRung, string> = {
  accounts: 'RungAccounts',
  permissions: 'RungPermissions',
  settings: 'RungSettings',
};

describe('every rung in CONNECTOR_RUNG_ORDER is mounted in connector-modal.tsx', () => {
  test('RUNG_COMPONENT names exactly the rungs CONNECTOR_RUNG_ORDER declares', () => {
    expect(Object.keys(RUNG_COMPONENT).sort()).toEqual([...CONNECTOR_RUNG_ORDER].sort());
  });

  for (const rung of CONNECTOR_RUNG_ORDER) {
    const component = RUNG_COMPONENT[rung];

    test(`'${rung}' mounts <${component}> inside TabsContent value="${rung}"`, () => {
      const opener = `value="${rung}"`;
      const openerIndex = source.indexOf(opener);
      // Fails if the TabsContent / TabsTrigger value itself disappears.
      expect(openerIndex).toBeGreaterThan(-1);

      // Prefer the TabsContent block over a TabsTrigger that shares the same
      // value= string — look for the component after the TabsContent that
      // owns this value. Both triggers and contents use value="…"; walk every
      // occurrence until the slice that contains the rung component.
      let searchFrom = 0;
      let found = false;
      while (searchFrom < source.length) {
        const idx = source.indexOf(opener, searchFrom);
        if (idx === -1) break;
        const nextValue = source.indexOf('value="', idx + opener.length);
        const block = source.slice(idx, nextValue === -1 ? source.length : nextValue);
        if (block.includes(`<${component}`)) {
          found = true;
          break;
        }
        searchFrom = idx + opener.length;
      }
      expect(found).toBe(true);
    });
  }
});
