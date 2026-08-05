/**
 * A SOURCE-LEVEL guard on the one property of the provision dedupe that no
 * unit test of `../lib/provision-idempotency.ts` can express: WHERE the check
 * sits in `r1.ts`'s POST /provision handler.
 *
 * `backend.createRepo` creates a real repository on the managed git host. A
 * dedupe that runs after it still returns the right project — and still leaves
 * an orphaned upstream repo behind on every retry, which is most of the defect
 * the key exists to fix. The lookup is only worth anything above that call.
 *
 * Reads the file as text. No database, no GitHub, no `mock.module` (which is
 * process-wide in this app and leaks into sibling suites) — same shape as
 * `../sandbox-deadline-call-sites.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const ROUTE_FILE = join(import.meta.dir, 'r1.ts');

async function provisionHandlerSource(): Promise<string> {
  const source = await Bun.file(ROUTE_FILE).text();
  // The provision handler runs from its route registration to the next route
  // registered on the app — slicing keeps a later handler's `createRepo` (or a
  // later idempotency helper) from satisfying an assertion about this one.
  const start = source.indexOf("path: '/provision'");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("path: '/{projectId}/git-token'", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('POST /provision resolves the idempotency key before it creates anything upstream', () => {
  test('the lookup precedes backend.createRepo', async () => {
    const handler = await provisionHandlerSource();

    const lookup = handler.indexOf('findIdempotentProvision(');
    const createRepo = handler.indexOf('backend.createRepo(');

    expect(lookup).toBeGreaterThan(-1);
    expect(createRepo).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(createRepo);
  });

  test('the short-circuit return precedes backend.createRepo', async () => {
    // The lookup being first is not enough — the early return it feeds has to
    // be there too, or the handler reads the key and provisions anyway.
    const handler = await provisionHandlerSource();

    expect(handler.indexOf('provisionReplayResponse(')).toBeLessThan(
      handler.indexOf('backend.createRepo('),
    );
  });

  test('the lookup precedes the quota check, so a retry is not refused by its own project', async () => {
    const handler = await provisionHandlerSource();

    expect(handler.indexOf('findIdempotentProvision(')).toBeLessThan(
      handler.indexOf('enforceProjectQuota('),
    );
  });

  test('the key is parsed before any of it is used', async () => {
    const handler = await provisionHandlerSource();

    expect(handler.indexOf('readProvisionIdempotencyKey(')).toBeLessThan(
      handler.indexOf('findIdempotentProvision('),
    );
  });

  test('the key is persisted on the project row, not just read', async () => {
    // Without the write there is nothing for the next call to find, and the
    // dedupe would survive neither a restart nor another replica.
    const handler = await provisionHandlerSource();

    expect(handler).toContain('idempotencyKey,');
    expect(handler.indexOf('.insert(projects)')).toBeGreaterThan(
      handler.indexOf('findIdempotentProvision('),
    );
  });

  test('the losing side of an insert race deletes the repo it minted', async () => {
    const handler = await provisionHandlerSource();

    const conflict = handler.indexOf('isProvisionIdempotencyConflict(');
    expect(conflict).toBeGreaterThan(-1);
    expect(handler.indexOf('backend.deleteRepo(', conflict)).toBeGreaterThan(conflict);
  });

  test('the stale "no idempotent re-link" comment is gone', async () => {
    // It stated the opposite of what this route now does, and a comment that
    // contradicts the code is worse than no comment.
    const handler = await provisionHandlerSource();

    expect(handler).not.toContain('no repoUrl to treat as an idempotent re-link');
  });
});
