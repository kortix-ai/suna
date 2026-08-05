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

/**
 * Comment prose wraps. Matching a sentence against raw source makes the
 * assertion depend on where the line breaks fall, so reflowing a paragraph
 * turns a guard red (or, worse, green) for no behavioural reason.
 */
function flattened(source: string): string {
  return source.replace(/\s+/g, ' ');
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

  test('the comment no longer claims provision cannot be idempotent', async () => {
    // The old text — "Provision always mints a brand-new managed repo, so the
    // quota check is a straight count" — stated the opposite of what this route
    // now does. Flattened, so reflowing the replacement paragraph cannot make
    // this pass or fail for the wrong reason. (The surviving clause "no repoUrl
    // to treat as an idempotent re-link" is still accurate: the QUOTA check
    // really has no repoUrl to key off. It is not the stale claim.)
    const handler = flattened(await provisionHandlerSource());

    expect(handler).not.toContain(
      'Provision always mints a brand-new managed repo, so the quota check is a straight count',
    );
    expect(handler).toContain('IDEMPOTENCY — MUST STAY ABOVE `backend.createRepo`');
  });

  test('a still-provisioning row is a 409, not a 201 carrying a doomed project_id', async () => {
    // The create path inserts with seed {expected:true, seeded:false} and only
    // then pushes; a failed push deletes the row. Replaying inside that gap
    // hands the caller an id that stops existing.
    const handler = await provisionHandlerSource();

    const classify = handler.indexOf('classifyProvisionReplay(');
    expect(classify).toBeGreaterThan(-1);
    expect(classify).toBeLessThan(handler.indexOf('backend.createRepo('));

    const inFlight = handler.indexOf("replay.kind === 'in_flight'");
    expect(inFlight).toBeGreaterThan(classify);
    // The 409 must come before the 201 branch, or the replay wins the race.
    expect(inFlight).toBeLessThan(handler.indexOf("replay.kind === 'replay'"));
    expect(handler.indexOf('provision_in_flight', inFlight)).toBeGreaterThan(inFlight);
  });

  test('the race cleanup records its OUTCOME, not just its intent', async () => {
    // An orphaned managed repo with no log is the acceptance criterion failing
    // invisibly, on the one path whose whole purpose is preventing orphans.
    const handler = await provisionHandlerSource();

    const conflict = handler.indexOf('isProvisionIdempotencyConflict(');
    const deleteCall = handler.indexOf('backend.deleteRepo(', conflict);
    expect(deleteCall).toBeGreaterThan(conflict);

    // A bare `catch {}` around the delete is exactly the swallowed failure.
    const cleanup = handler.slice(conflict, handler.indexOf('setContextField', deleteCall));
    expect(cleanup).not.toMatch(/catch\s*\{\s*\/\*[^*]*\*\/\s*\}/);
    expect(cleanup).toContain('ORPHANED MANAGED REPO');
    expect(cleanup.indexOf('console.error')).toBeGreaterThan(-1);
  });

  test('the replay does not claim a project grant the caller may not hold', async () => {
    const handler = await provisionHandlerSource();

    expect(handler).toContain('provisionReplayAccess(');
    // Every replay response resolves access; none hard-codes it.
    const replayCalls = handler.match(/provisionReplayResponse\(/g) ?? [];
    const accessCalls = handler.match(/provisionReplayAccess\(/g) ?? [];
    expect(replayCalls).toHaveLength(2);
    expect(accessCalls).toHaveLength(2);
  });

  test('the key-is-not-a-fingerprint non-goal is stated for callers', async () => {
    // Task 6 picks the key. Silence here would leave "same key, different name"
    // as undocumented behaviour a client could reasonably get wrong.
    const handler = flattened(await provisionHandlerSource());

    expect(handler).toContain('It identifies the ATTEMPT, not the payload');
  });
});
