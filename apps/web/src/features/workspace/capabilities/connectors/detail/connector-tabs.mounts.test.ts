import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONNECTOR_TABS, type ConnectorTab } from './connector-tabs';

const source = readFileSync(join(import.meta.dir, 'connector-modal.tsx'), 'utf8');

/**
 * Guards the one defect no other gate catches: a tab component that is
 * imported, exported and independently tested — but never mounted in
 * `connector-modal.tsx`. `no-unused-vars` is off in this repo and
 * `noUnusedLocals` is unset, so deleting a JSX mount while leaving its
 * `import` in place trips neither eslint nor `tsc`. It has happened twice.
 *
 * Keyed off `CONNECTOR_TABS` rather than a literal list, so a tab added later
 * with no entry in `TAB_COMPONENT` fails on the first test instead of the loop
 * silently iterating zero times.
 */
const TAB_COMPONENT: Record<ConnectorTab, string> = {
  accounts: 'ConnectorAccounts',
  tools: 'ConnectorTools',
  settings: 'ConnectorSettings',
};

describe('every tab in CONNECTOR_TABS is mounted in connector-modal.tsx', () => {
  test('TAB_COMPONENT names exactly the tabs CONNECTOR_TABS declares', () => {
    expect(Object.keys(TAB_COMPONENT).sort()).toEqual([...CONNECTOR_TABS].sort());
  });

  for (const tab of CONNECTOR_TABS) {
    const component = TAB_COMPONENT[tab];

    test(`'${tab}' mounts <${component}> inside TabsContent value="${tab}"`, () => {
      const opener = `value="${tab}"`;
      const openerIndex = source.indexOf(opener);
      // Fails if the TabsContent / TabsTrigger value itself disappears.
      expect(openerIndex).toBeGreaterThan(-1);

      // Prefer the TabsContent block over a TabsTrigger that shares the same
      // value= string — look for the component after the TabsContent that
      // owns this value. Both triggers and contents use value="…"; walk every
      // occurrence until the slice that contains the tab component.
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
