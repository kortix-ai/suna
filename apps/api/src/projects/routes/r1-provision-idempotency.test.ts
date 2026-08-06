/**
 * A SOURCE-LEVEL guard on the one property of the provision dedupe that no
 * unit test of `../lib/provision-idempotency.ts` can express: WHERE the check
 * sits in `runProvision` (`../provision-core.ts`).
 *
 * `backend.createRepo` creates a real repository on the managed git host. A
 * dedupe that runs after it still returns the right project — and still leaves
 * an orphaned upstream repo behind on every retry, which is most of the defect
 * the key exists to fix. The lookup is only worth anything above that call.
 *
 * Reads the file as text. No database, no GitHub, no `mock.module` (which is
 * process-wide in this app and leaks into sibling suites) — same shape as
 * `../sandbox-deadline-call-sites.test.ts`.
 *
 * REPOINTED by Task 16 (workspace-switcher, 2026-08-06): this guard used to
 * read `r1.ts`'s POST /provision handler directly. That handler's body now
 * lives in `runProvision` (`../provision-core.ts`), extracted so a streaming
 * variant of the route can share it instead of forking a second copy of the
 * create logic. Every assertion below is UNCHANGED IN SUBSTANCE — only the
 * file it reads, and the markers used to slice out the handler body, moved
 * with the code. `r1.ts`'s own POST /provision handler is now a thin wrapper
 * (`buildProvisionContext` + `runProvision` + `c.json(result.body, ...)`)
 * with nothing left in it for a source guard to check.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const CORE_FILE = join(import.meta.dir, '../provision-core.ts');

async function runProvisionSource(): Promise<string> {
  const source = await Bun.file(CORE_FILE).text();
  // `runProvision` is the LAST export in the file. Slicing to its start
  // excludes `buildProvisionContext` and the `provisionReplayAccess`
  // DEFINITION (both declared above it in the same file), so the call-count
  // assertions below see only the two CALL sites inside `runProvision`, not
  // a third phantom match on the declaration — same property the original
  // `path: '/provision'` .. `path: '/{projectId}/git-token'` slice enforced
  // in `r1.ts`.
  const start = source.indexOf('export async function runProvision(');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start);
}

/**
 * Comment prose wraps. Matching a sentence against raw source makes the
 * assertion depend on where the line breaks fall, so reflowing a paragraph
 * turns a guard red (or, worse, green) for no behavioural reason.
 */
function flattened(source: string): string {
  return source.replace(/\s+/g, ' ');
}

/**
 * Source with comments removed, for assertions that COUNT call sites. A
 * docstring naming a function is not a call to it, and counting both makes the
 * guard fail when someone documents the code — which is the "passes for the
 * wrong reason" failure mode in the other direction.
 *
 * `[^:]` guards `https://`; block comments go first so a `//` inside one cannot
 * survive.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('POST /provision resolves the idempotency key before it creates anything upstream', () => {
  test('the lookup precedes backend.createRepo', async () => {
    const handler = await runProvisionSource();

    const lookup = handler.indexOf('findIdempotentProvision(');
    const createRepo = handler.indexOf('backend.createRepo(');

    expect(lookup).toBeGreaterThan(-1);
    expect(createRepo).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(createRepo);
  });

  test('the short-circuit return precedes backend.createRepo', async () => {
    // The lookup being first is not enough — the early return it feeds has to
    // be there too, or the handler reads the key and provisions anyway.
    const handler = await runProvisionSource();

    expect(handler.indexOf('provisionReplayResponse(')).toBeLessThan(
      handler.indexOf('backend.createRepo('),
    );
  });

  test('the lookup precedes the quota check, so a retry is not refused by its own project', async () => {
    const handler = await runProvisionSource();

    expect(handler.indexOf('findIdempotentProvision(')).toBeLessThan(
      handler.indexOf('enforceProjectQuota('),
    );
  });

  test('the key is parsed before any of it is used', async () => {
    const handler = await runProvisionSource();

    expect(handler.indexOf('readProvisionIdempotencyKey(')).toBeLessThan(
      handler.indexOf('findIdempotentProvision('),
    );
  });

  test('the key is persisted on the project row, not just read', async () => {
    // Without the write there is nothing for the next call to find, and the
    // dedupe would survive neither a restart nor another replica.
    const handler = await runProvisionSource();

    expect(handler).toContain('idempotencyKey,');
    expect(handler.indexOf('.insert(projects)')).toBeGreaterThan(
      handler.indexOf('findIdempotentProvision('),
    );
  });

  test('the losing side of an insert race deletes the repo it minted', async () => {
    const handler = await runProvisionSource();

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
    const handler = flattened(await runProvisionSource());

    expect(handler).not.toContain(
      'Provision always mints a brand-new managed repo, so the quota check is a straight count',
    );
    expect(handler).toContain('IDEMPOTENCY — MUST STAY ABOVE `backend.createRepo`');
  });

  test('a still-provisioning row is a 409, not a 201 carrying a doomed project_id', async () => {
    // The create path inserts with seed {expected:true, seeded:false} and only
    // then pushes; a failed push deletes the row. Replaying inside that gap
    // hands the caller an id that stops existing.
    const handler = await runProvisionSource();

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
    const handler = await runProvisionSource();

    const conflict = handler.indexOf('isProvisionIdempotencyConflict(');
    const deleteCall = handler.indexOf('backend.deleteRepo(', conflict);
    expect(deleteCall).toBeGreaterThan(conflict);

    // A bare `catch {}` around the delete is exactly the swallowed failure.
    const cleanup = handler.slice(conflict, handler.indexOf('setContextField', deleteCall));
    expect(cleanup).not.toMatch(/catch\s*\{\s*\/\*[^*]*\*\/\s*\}/);
    expect(cleanup).toContain('ORPHANED MANAGED REPO');
    expect(cleanup.indexOf('console.error')).toBeGreaterThan(-1);
  });

  test('the insert-race loser classifies the winner too — one rule, both call sites', async () => {
    // The pre-check path's guards CANNOT catch this: the defect is that the
    // second replay call site never classifies at all.
    //
    // A and B carry one key and both pass the pre-check. A inserts; B's insert
    // raises 23505; B deletes its own repo and re-reads A — MILLISECONDS after
    // A's INSERT, while A's seed push is still running. So on this path "the
    // winner is still in flight" is the normal case, not a narrow overlap, and
    // replaying A's project_id hands B an id that A's rollback may delete.
    const handler = await runProvisionSource();
    const raceTail = handler.slice(handler.indexOf('isProvisionIdempotencyConflict('));

    const classify = raceTail.indexOf('classifyProvisionReplay(');
    const replay = raceTail.indexOf('provisionReplayResponse(');
    expect(classify).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(-1);
    expect(classify).toBeLessThan(replay);
    expect(raceTail.indexOf('provision_in_flight')).toBeLessThan(replay);
  });

  test('both replay call sites go through the SAME classifier, not a parallel rule', async () => {
    const code = codeOnly(await runProvisionSource());

    // Two replay responses (pre-check + race loser) and two classifications.
    expect(code.match(/provisionReplayResponse\(/g) ?? []).toHaveLength(2);
    expect(code.match(/classifyProvisionReplay\(/g) ?? []).toHaveLength(2);
    // No second, hand-rolled copy of the in-flight rule in the route: the seed
    // state and the window belong to the classifier, and only to it.
    expect(code).not.toContain('seed.expected');
    expect(code).not.toContain('readManagedRepoSeedState');
    expect(code).not.toContain('PROVISION_IN_FLIGHT_WINDOW_MS');
  });

  test('the replay does not claim a project grant the caller may not hold', async () => {
    const handler = await runProvisionSource();

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
    const handler = flattened(await runProvisionSource());

    expect(handler).toContain('It identifies the ATTEMPT, not the payload');
  });

  test('runProvision never calls c.json — it returns a plain result the caller shapes', async () => {
    // New for Task 16: the extraction's entire point is that `runProvision`
    // has no Hono-response coupling, so a streaming route can turn its result
    // into an SSE event instead of a single JSON response. A stray `c.json(`
    // here would mean a return path was missed during extraction.
    const handler = await runProvisionSource();

    expect(handler).not.toContain('c.json(');
    expect(handler).toContain('status: 201');
  });
});
