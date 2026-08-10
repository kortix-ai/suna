import { describe, expect, test } from 'bun:test';

import {
  accountProjectCountForArchive,
  buildProjectSavePatch,
  runProjectArchive,
  type RunProjectArchiveClient,
} from './settings-view';

/**
 * `runProjectArchive` is the archive mutation's real side effects, extracted
 * so this test can inject a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — see the function's own doc comment for
 * why that matters in this monorepo.
 *
 * These pin the exact contract the deleted `/projects` list page's archive
 * handler carried: suppress auto-recreate only when this was the account's
 * last active project, only after the archive call itself succeeds, and
 * never on failure — proven by counting real invocations of the injected
 * `onSuppress` spy, not by asserting a symbol appears in the source.
 */
describe('runProjectArchive', () => {
  function client(overrides: Partial<RunProjectArchiveClient> = {}): RunProjectArchiveClient {
    return {
      archiveProject: async () => undefined,
      ...overrides,
    };
  }

  test('suppresses auto-recreate when this was the account\'s last active project', async () => {
    let suppressCalls = 0;
    await runProjectArchive('p1', 1, client(), () => {
      suppressCalls += 1;
    });
    expect(suppressCalls).toBe(1);
  });

  test('also suppresses when the account was already down to zero', async () => {
    // Defensive: an already-empty account (e.g. a stale count) must not skip
    // the guard just because the arithmetic edge is unusual.
    let suppressCalls = 0;
    await runProjectArchive('p1', 0, client(), () => {
      suppressCalls += 1;
    });
    expect(suppressCalls).toBe(1);
  });

  test('does NOT suppress when other active projects remain in the account', async () => {
    let suppressCalls = 0;
    await runProjectArchive('p1', 3, client(), () => {
      suppressCalls += 1;
    });
    expect(suppressCalls).toBe(0);
  });

  test('does NOT suppress when the count is unknown (null) — fails closed', async () => {
    // The count comes from a DEPENDENT query (accountProjectsQuery) that can
    // still be loading, or can have errored, when Archive is clicked — unlike
    // the deleted list page, whose count and Archive button read the same
    // query. `null` means "don't know", and the safe direction is to NOT
    // suppress: one unwanted auto-create costs far less than a false
    // suppression, which blocks auto-create for the next empty account this
    // tab visits with nothing left to clear it.
    let suppressCalls = 0;
    await runProjectArchive('p1', null, client(), () => {
      suppressCalls += 1;
    });
    expect(suppressCalls).toBe(0);
  });

  test('null and 0 are NOT the same input — only 0 suppresses', async () => {
    // Pins the exact bug this guards against: the component used to read
    // `accountProjectsQuery.data?.length ?? 0`, which silently turned
    // "not loaded yet" into "zero projects remain" and suppressed by
    // accident. This proves the two inputs now take different branches.
    const results: Record<string, number> = {};
    for (const count of [null, 0] as const) {
      let suppressCalls = 0;
      await runProjectArchive('p1', count, client(), () => {
        suppressCalls += 1;
      });
      results[String(count)] = suppressCalls;
    }
    expect(results.null).toBe(0);
    expect(results['0']).toBe(1);
  });

  test('does NOT suppress when the archive call itself fails', async () => {
    // A failed archive leaves the project alive — suppressing here would
    // wrongly block auto-provision for a project that still exists.
    let suppressCalls = 0;
    const failing = client({
      archiveProject: async () => {
        throw new Error('archive failed');
      },
    });

    await expect(
      runProjectArchive('p1', 1, failing, () => {
        suppressCalls += 1;
      }),
    ).rejects.toThrow('archive failed');
    expect(suppressCalls).toBe(0);
  });

  test('calls archiveProject with the given project id', async () => {
    const calls: string[] = [];
    await runProjectArchive(
      'the-project-id',
      1,
      client({
        archiveProject: async (projectId) => {
          calls.push(projectId);
        },
      }),
      () => {},
    );
    expect(calls).toEqual(['the-project-id']);
  });

  test('suppression fires strictly after archiveProject resolves, not before', async () => {
    // Ordering matters: onSuppress must observe a completed archive, never a
    // still-in-flight one.
    const events: string[] = [];
    await runProjectArchive(
      'p1',
      1,
      client({
        archiveProject: async () => {
          events.push('archived');
        },
      }),
      () => events.push('suppressed'),
    );
    expect(events).toEqual(['archived', 'suppressed']);
  });
});

/**
 * `accountProjectCountForArchive` is the exact expression the component
 * passes to `runProjectArchive` (`SettingsView`'s `archiveMutation`), pulled
 * out so the real `accountProjectsQuery.data` -> count wiring is under test,
 * not just `runProjectArchive` called with an explicitly-chosen count. This
 * is the fix for the false-positive-suppression bug: the old inline
 * `accountProjectsQuery.data?.length ?? 0` could not distinguish "still
 * loading" / "errored" from "confirmed zero projects".
 */
describe('accountProjectCountForArchive', () => {
  test('undefined data (loading OR errored — react-query leaves both undefined) maps to null, not 0', () => {
    expect(accountProjectCountForArchive(undefined)).toBeNull();
  });

  test('a loaded list of one project maps to 1', () => {
    expect(accountProjectCountForArchive([{ project_id: 'p1' }])).toBe(1);
  });

  test('a genuinely empty loaded list maps to 0, not null', () => {
    // Zero-length is a real, confirmed answer — distinct from "unknown" even
    // though `[]` is falsy-adjacent territory for naive checks.
    expect(accountProjectCountForArchive([])).toBe(0);
  });

  test('several loaded projects maps to their count', () => {
    expect(accountProjectCountForArchive([{ p: 1 }, { p: 2 }, { p: 3 }])).toBe(3);
  });
});

/**
 * `buildProjectSavePatch` is `GeneralProjectCard`'s combined name+icon
 * autosave effect, extracted the same way `runProjectArchive` is above: a
 * plain function this test can call directly, instead of mounting the
 * component or reaching for `mock.module('@kortix/sdk', ...)`. It is the
 * exact value the effect passes to `mutate` — i.e. exactly what
 * `updateProject(project.project_id, patch)` receives — so these pin the
 * capability the create/edit-modal deletion (Task 23) moved into workspace
 * Settings: an existing project's icon is editable, and emoji/glyph stay
 * mutually exclusive in the request the same way `project-edit-patch.test.ts`
 * already proves for the shared diff underneath.
 */
describe('buildProjectSavePatch', () => {
  const PLAIN = { name: 'Atlas', icon: null, icon_glyph: null };
  const ICONED = { name: 'Atlas', icon: '🚀', icon_glyph: null };
  const GLYPHED = { name: 'Atlas', icon: null, icon_glyph: { name: 'Rocket', color: 'blue' } };

  test('picking a first emoji reaches updateProject as `icon`, with no `icon_glyph` key', () => {
    const patch = buildProjectSavePatch(PLAIN, { name: 'Atlas', icon: { emoji: '🎯' } });

    expect(patch).toEqual({ icon: '🎯' });
    expect(patch && 'icon_glyph' in patch).toBe(false);
  });

  test('picking a first glyph reaches updateProject as `icon_glyph`, with no `icon` key', () => {
    const patch = buildProjectSavePatch(PLAIN, {
      name: 'Atlas',
      icon: { glyph: { name: 'Rocket', color: 'blue' } },
    });

    expect(patch).toEqual({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(patch && 'icon' in patch).toBe(false);
  });

  test('switching an emoji project to a glyph sends `icon_glyph`, and NEVER `icon: null`', () => {
    // The server invariant this whole feature protects: writing `icon_glyph`
    // already deletes the stored emoji server-side, so a patch that ALSO
    // carried `icon: null` would be a redundant extra write at best.
    const patch = buildProjectSavePatch(ICONED, {
      name: 'Atlas',
      icon: { glyph: { name: 'Rocket', color: 'blue' } },
    });

    expect(patch).toEqual({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(patch && 'icon' in patch).toBe(false);
  });

  test('switching a glyph project to an emoji sends `icon`, and NEVER `icon_glyph: null`', () => {
    const patch = buildProjectSavePatch(GLYPHED, { name: 'Atlas', icon: { emoji: '🚀' } });

    expect(patch).toEqual({ icon: '🚀' });
    expect(patch && 'icon_glyph' in patch).toBe(false);
  });

  test('removing an emoji sends an explicit `icon: null`, never `icon_glyph`', () => {
    const patch = buildProjectSavePatch(ICONED, { name: 'Atlas', icon: null });

    expect(patch).toEqual({ icon: null });
    expect(patch && 'icon_glyph' in patch).toBe(false);
  });

  test('removing a glyph sends an explicit `icon_glyph: null`, never `icon`', () => {
    const patch = buildProjectSavePatch(GLYPHED, { name: 'Atlas', icon: null });

    expect(patch).toEqual({ icon_glyph: null });
    expect(patch && 'icon' in patch).toBe(false);
  });

  test('an untouched draft sends nothing — the effect must not call updateProject', () => {
    expect(buildProjectSavePatch(ICONED, { name: 'Atlas', icon: { emoji: '🚀' } })).toBeNull();
    expect(buildProjectSavePatch(PLAIN, { name: 'Atlas', icon: null })).toBeNull();
  });

  test('a rename alone carries no icon key at all', () => {
    const patch = buildProjectSavePatch(ICONED, { name: 'Atlas 2', icon: { emoji: '🚀' } });

    expect(patch).toEqual({ name: 'Atlas 2' });
    expect(patch && 'icon' in patch).toBe(false);
  });

  test('a rename and an icon change travel together in one patch', () => {
    const patch = buildProjectSavePatch(ICONED, { name: 'Atlas 2', icon: { emoji: '🎯' } });

    expect(patch).toEqual({ name: 'Atlas 2', icon: '🎯' });
  });

  test('emptying the name sends nothing, even when the icon also changed', () => {
    // Matches the modal-era contract in `project-edit-patch.ts`: a project
    // must have a name, so an empty name blocks the whole save rather than
    // silently saving the icon and dropping the name change.
    expect(
      buildProjectSavePatch(ICONED, { name: '   ', icon: { emoji: '🎯' } }),
    ).toBeNull();
  });
});
