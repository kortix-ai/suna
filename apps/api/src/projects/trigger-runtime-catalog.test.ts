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
    type: 'cron',
    agent: 'kortix',
    model: null,
    enabled: true,
    promptTemplate: 'Run',
    cron: '* * * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
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

  // Regression guard for the merge with main's exact-slot scheduler. The
  // runtime catalog became the fire registry, and reconcile REMOVES any row
  // whose slug is absent from the specs it is handed. A caller that reads the
  // manifest without the `goals` opt-in therefore does not merely fail to
  // register goal triggers — it deletes the ones another caller registered, so
  // a `goals:` block flickers in on a UI read and is reaped by the next sweep.
  // This asserts the destructive half directly, so any future caller that
  // forgets the opt-in fails here instead of in production.
  test('a goal-derived trigger absent from the declared specs is REMOVED', async () => {
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [{ slug: 'goal-platinum-seo' }, { slug: 'nightly' }],
      upsert: async () => {},
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    // What a goals-less `extractTriggers(manifest)` hands in: authored only.
    await reconcileProjectTriggerRuntimeWithStore('project-1', [trigger('nightly')], store);
    expect(removed).toEqual(['goal-platinum-seo']);
  });

  test('the same goal trigger survives when the specs include it', async () => {
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [{ slug: 'goal-platinum-seo' }, { slug: 'nightly' }],
      upsert: async () => {},
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [trigger('nightly'), trigger('goal-platinum-seo')],
      store,
    );
    expect(removed).toEqual([]);
  });
});
