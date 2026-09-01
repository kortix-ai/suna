import { describe, expect, test } from 'bun:test';
import {
  type TriggerRuntimeCatalogStore,
  reconcileProjectTriggerRuntimeWithStore,
} from './trigger-runtime-catalog-core';
import { triggerScheduleRevision } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

function trigger(slug: string, pinnedSessionId: string | null = null): GitTriggerSpec {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name: slug,
    subprojectSlug: null,
    type: 'cron',
    agent: 'kortix',
    model: null,
    enabled: true,
    promptTemplate: 'Run',
    cron: '* * * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    run: null,
    monitorMode: null,
    intervalSeconds: null,
    expectEventWithinSeconds: null,
    sessionMode: pinnedSessionId ? 'pinned' : 'fresh',
    pinnedSessionId,
    sessionKey: null,
    filter: null,
  };
}

describe('reconcileProjectTriggerRuntime', () => {
  test('upserts every readable trigger and removes only proven stale rows', async () => {
    const upserted: Array<{ slug: string; sessionId: string | null }> = [];
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [
        {
          slug: 'keep',
          sessionId: null,
          scheduleRevision: triggerScheduleRevision(trigger('keep')),
        },
        { slug: 'stale' },
      ],
      upsert: async (_projectId, spec) => {
        upserted.push({ slug: spec.slug, sessionId: spec.pinnedSessionId });
      },
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    const result = await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [trigger('keep'), trigger('new-pinned', 'session-1')],
      store,
    );

    expect(upserted).toEqual([{ slug: 'new-pinned', sessionId: 'session-1' }]);
    expect(removed).toEqual(['stale']);
    expect(result).toEqual({ upserted: 1, removed: 1 });
  });

  test('removes all rows when a readable manifest declares no triggers', async () => {
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [{ slug: 'existing' }],
      upsert: async () => {},
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    await expect(reconcileProjectTriggerRuntimeWithStore('project-1', [], store)).resolves.toEqual({
      upserted: 0,
      removed: 1,
    });
    expect(removed).toEqual(['existing']);
  });

  test('preserves rows when a non-destructive read observes a stale manifest', async () => {
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [{ slug: 'new-trigger' }],
      upsert: async () => {},
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    await expect(
      reconcileProjectTriggerRuntimeWithStore('project-1', [], store, { pruneStale: false }),
    ).resolves.toEqual({ upserted: 0, removed: 0 });
    expect(removed).toEqual([]);
  });
});

/**
 * `subproject_slug` is materialized here, so it must also be part of the
 * change-detection comparison. Without that, a manifest edit that ONLY adds or
 * removes `subproject:` changes neither the pinned session nor the schedule
 * revision — the reconcile would skip the write, the column would stay stale,
 * and the subproject's run report would be empty (or claim a trigger it no longer
 * owns) while every trigger fired normally. Nothing would error.
 */
describe('reconcileProjectTriggerRuntime — subproject ownership', () => {
  function subprojectTrigger(slug: string, subprojectSlug: string | null): GitTriggerSpec {
    return { ...trigger(slug), subprojectSlug };
  }

  /** A store whose existing row already matches on schedule + session. */
  function storeWith(existingSubprojectSlug: string | null | undefined) {
    const upserted: Array<string | null> = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [
        {
          slug: 'seo-weekly',
          sessionId: null,
          ...(existingSubprojectSlug === undefined ? {} : { subprojectSlug: existingSubprojectSlug }),
          scheduleRevision: triggerScheduleRevision(trigger('seo-weekly')),
        },
      ],
      upsert: async (_projectId, spec) => {
        upserted.push(spec.subprojectSlug);
      },
      remove: async () => {},
    };
    return { store, upserted };
  }

  test('a trigger that GAINS an owner is written', async () => {
    const { store, upserted } = storeWith(null);
    const result = await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [subprojectTrigger('seo-weekly', 'seo-watch')],
      store,
    );
    expect(upserted).toEqual(['seo-watch']);
    expect(result.upserted).toBe(1);
  });

  test('a trigger that LOSES its owner is written, clearing the column', async () => {
    const { store, upserted } = storeWith('seo-watch');
    await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [subprojectTrigger('seo-weekly', null)],
      store,
    );
    expect(upserted).toEqual([null]);
  });

  test('a trigger that changes owner is written', async () => {
    const { store, upserted } = storeWith('seo-watch');
    await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [subprojectTrigger('seo-weekly', 'other-subproject')],
      store,
    );
    expect(upserted).toEqual(['other-subproject']);
  });

  test('an unchanged owner is NOT rewritten', async () => {
    const { store, upserted } = storeWith('seo-watch');
    const result = await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [subprojectTrigger('seo-weekly', 'seo-watch')],
      store,
    );
    expect(upserted).toEqual([]);
    expect(result.upserted).toBe(0);
  });

  test('a legacy row that predates the column converges to null, not to a write loop', async () => {
    // `subprojectSlug` absent from the selected row (a store that never had it).
    // A hand-authored trigger must settle, or every sweep would rewrite it.
    const { store, upserted } = storeWith(undefined);
    const result = await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [subprojectTrigger('seo-weekly', null)],
      store,
    );
    expect(upserted).toEqual([]);
    expect(result.upserted).toBe(0);
  });
});
