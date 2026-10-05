import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { changeRequestKeys } from '@/features/project-files/hooks/use-change-requests';

/**
 * A session's outcome cards poll change requests every 60 s per open thread.
 * They read ONE session's list, filtered by the server, and that entry must
 * still be reached by the invalidations the change-request dialog issues —
 * otherwise a card keeps saying "Waiting for you" after a merge.
 */
describe('session outcomes read a server-scoped, invalidatable list', () => {
  test('the session list nests under the project and list-scope prefixes', () => {
    const key = changeRequestKeys.sessionList('P1', 'S1');
    const project = changeRequestKeys.project('P1');
    const listScope = changeRequestKeys.listScope('P1');
    expect(key.slice(0, project.length)).toEqual([...project]);
    expect(key.slice(0, listScope.length)).toEqual([...listScope]);
  });

  test('the provider polls the session-scoped hook, not the whole project list', () => {
    const source = readFileSync(new URL('./session-outcomes-provider.tsx', import.meta.url), 'utf8');
    expect(source).toContain('useSessionChangeRequests(projectSessionId');
    expect(source).not.toMatch(/useChangeRequests\('all'/);
  });
});
