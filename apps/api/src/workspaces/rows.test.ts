import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';

import { accountsView, projectsView } from './rows';

// The read handles are the tables at runtime and views to the compiler. The
// checks below run in `pnpm --filter kortix-api typecheck`: each write through
// a handle must stay a type error, so every write goes through a rows.ts
// function.
describe('workspaces/rows read handles', () => {
  test('a write through a read handle does not compile', () => {
    const writes = (database: Database) => [
      // @ts-expect-error a read handle is not a write target
      database.update(projectsView),
      // @ts-expect-error a read handle is not a write target
      database.insert(accountsView),
      // @ts-expect-error a read handle is not a write target
      database.delete(projectsView),
    ];
    expect(typeof writes).toBe('function');
  });
});
