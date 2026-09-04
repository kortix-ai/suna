/**
 * Source-level guards on `provision-core.ts`'s phase emitter — the property
 * no behavioural test can express: WHERE each `emit(...)` sits relative to
 * the work it names.
 *
 * Emitting a phase AFTER its work completes makes a UI show a step as
 * finished while the one actually running sits idle — the checklist stalls
 * on the wrong row. Reads the file as text, same shape as
 * `routes/r1-provision-idempotency.test.ts`. No database, no GitHub, no
 * `mock.module`.
 */
import { describe, expect, test } from 'bun:test';

import { PROVISION_PHASES } from './provision-core';

async function coreSource(): Promise<string> {
  return Bun.file(new URL('./provision-core.ts', import.meta.url)).text();
}

describe('provision phases', () => {
  test('are declared in the order the handler walks them', () => {
    expect(PROVISION_PHASES).toEqual([
      'validating',
      'creating_repository',
      'registering',
      'seeding',
    ]);
  });

  test('there are exactly four phases — not three, not five', () => {
    // A pure `toEqual` above already pins the exact array, but a length
    // assertion fails independently if the array is ever replaced by
    // something that still happens to equal-compare (e.g. a Proxy).
    expect(PROVISION_PHASES).toHaveLength(4);
  });

  test("emit('validating') is the first statement in runProvision, before any request validation", async () => {
    const source = await coreSource();
    const fnStart = source.indexOf('export async function runProvision(');
    expect(fnStart).toBeGreaterThan(-1);

    const emitValidating = source.indexOf("emit('validating')", fnStart);
    const providerCheck = source.indexOf('defaultManagedProviderId()', fnStart);
    const nameCheck = source.indexOf("name is required", fnStart);
    expect(emitValidating).toBeGreaterThan(-1);
    expect(providerCheck).toBeGreaterThan(-1);
    expect(nameCheck).toBeGreaterThan(-1);

    // Not just "before the name checks" (the brief's example) — before EVERY
    // check in the function, since it is the function's first statement.
    expect(emitValidating).toBeLessThan(providerCheck);
    expect(emitValidating).toBeLessThan(nameCheck);
  });

  test("emit('creating_repository') is immediately before backend.createRepo, never after", async () => {
    const source = await coreSource();
    const emitIndex = source.indexOf("emit('creating_repository')");
    const workIndex = source.indexOf('backend.createRepo(');
    expect(emitIndex).toBeGreaterThan(-1);
    expect(workIndex).toBeGreaterThan(emitIndex);

    // "Immediately before" — nothing but the declaration + try/catch wrapper
    // between the emit and the call. A large gap would mean other work (the
    // quota check, the idempotency lookup) is hiding behind this phase's
    // label instead of its own.
    const between = source.slice(emitIndex, workIndex);
    expect(between.length).toBeLessThan(160);
  });

  test("emit('registering') is immediately before the project row insert, never after", async () => {
    const source = await coreSource();
    const emitIndex = source.indexOf("emit('registering')");
    const workIndex = source.indexOf('await insertProjectRow()');
    expect(emitIndex).toBeGreaterThan(-1);
    expect(workIndex).toBeGreaterThan(emitIndex);

    const between = source.slice(emitIndex, workIndex);
    expect(between.length).toBeLessThan(80);
  });

  // THE INVARIANT: a project always has a manifest. Seeding is the DEFAULT —
  // a caller who says nothing (bare `POST /v1/projects/provision`, an agent,
  // any integration) gets the starter. This used to be opt-in
  // (`body.seed_starter === true`), which is how such a caller got a repo with
  // no kortix.yaml, no agents and no skills, recorded `caller_opted_out` so the
  // self-heal skipped it forever. Pinned here because the regression is silent:
  // provisioning still returns 201 `{status:'active'}` for an empty repo.
  test('seeding is the DEFAULT — only an explicit seed_starter:false opts out', async () => {
    const source = await coreSource();

    // The opt-out is an explicit `false`, never the absence of the flag.
    expect(source).toContain('body.seed_starter === false');
    expect(source).toContain('const seedStarter = !clientOwnsFirstCommit');

    // The old opt-in form must be gone: `=== true` as the seed gate is exactly
    // the defect. (`=== false` above legitimately contains neither.)
    expect(source).not.toContain('body.seed_starter === true');
  });

  test('even an opt-out records expected:true, so an unpushed repo is still repaired', async () => {
    const source = await coreSource();
    // `caller_opted_out` recorded `expected:false`, which made
    // shouldSelfHealManagedRepoSeed skip the repo permanently.
    expect(source).toContain("reason: 'client_owns_first_commit'");
    expect(source).not.toContain("reason: 'caller_opted_out'");
  });

  test("emit('seeding') is before the seed decision, never after the seed push starts", async () => {
    const source = await coreSource();
    const emitIndex = source.indexOf("emit('seeding')");
    const seedDecision = source.indexOf('if (seedStarter)');
    const pushCall = source.indexOf('await pushVerifiedSeed(');
    expect(emitIndex).toBeGreaterThan(-1);
    expect(seedDecision).toBeGreaterThan(emitIndex);
    expect(pushCall).toBeGreaterThan(seedDecision);
  });

  test('the four emits appear in source in the same order PROVISION_PHASES declares', async () => {
    const source = await coreSource();
    const indices = PROVISION_PHASES.map((phase) => {
      const idx = source.indexOf(`emit('${phase}')`);
      expect(idx).toBeGreaterThan(-1);
      return idx;
    });
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  test('runProvision returns a plain {status, body} result, never calls c.json', async () => {
    // The whole point of the extraction: no Hono-response coupling, so a
    // streaming route can reshape the result into an SSE event instead of a
    // single JSON response. A stray `c.json(` here would mean some return
    // path was missed during extraction.
    const source = await coreSource();
    const fnStart = source.indexOf('export async function runProvision(');
    const fnBody = source.slice(fnStart);
    expect(fnBody).not.toContain('c.json(');
    expect(fnBody).toContain('return {');
    expect((fnBody.match(/status:\s*201/g) ?? []).length).toBeGreaterThan(0);
  });

  test('precomputes the Git hint after a verified seed only when fast boot is enabled', async () => {
    const source = await coreSource();
    const seedState = source.indexOf('const verifiedSeedState');
    const gate = source.indexOf('if (config.KORTIX_FAST_GIT_BOOT_ENABLED');
    const precompute = source.indexOf('resolveFastBootGitHintWithCache(', gate);
    expect(seedState).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(seedState);
    expect(precompute).toBeGreaterThan(gate);
    expect(source.slice(gate, precompute)).toContain('writeUpstream');
    expect(source).toContain('FAST_BOOT_SEED_HINT_TIMEOUT_MS = 8_000');
  });
});
