import { describe, expect, test } from 'bun:test';
import { AGI_AGENT_NAME } from '@kortix/shared';
import { goalPushTriggerSlug } from '@kortix/manifest-schema';
import { extractGoals, extractTriggers, parseManifestString, type GitGoalSpec } from './triggers';
import {
  type TriggerRuntimeCatalogStore,
  reconcileProjectTriggerRuntimeWithStore,
} from './trigger-runtime-catalog-core';

function manifest(goals: string, triggers = '') {
  return parseManifestString(
    `kortix_version: 2
default_agent: worker
agents:
  worker: {}
goals:
${goals}${triggers}`,
    'yaml',
    'kortix.yaml',
  );
}

describe('goal manifest parsing and trigger desugaring', () => {
  test('parses a goal into the typed GitGoalSpec shape', () => {
    const loaded = extractGoals(
      manifest(`  - slug: grow-revenue
    title: Grow recurring revenue
    done_when: Revenue reaches 100000 with churn below 2%.
    status: active
    push: "0 0 9 * * *"
    timezone: America/New_York
    agent: worker
    metrics:
      - name: revenue
        direction: increase
        target: 100000
        unit: USD
      - name: churn
        direction: decrease
`),
    );

    expect(loaded.errors).toEqual([]);
    const goal: GitGoalSpec = loaded.specs[0]!;
    expect(goal).toEqual({
      slug: 'grow-revenue',
      path: 'kortix.yaml#goals.grow-revenue',
      title: 'Grow recurring revenue',
      doneWhen: 'Revenue reaches 100000 with churn below 2%.',
      status: 'active',
      pushCron: '0 0 9 * * *',
      timezone: 'America/New_York',
      agent: 'worker',
      metrics: [
        { name: 'revenue', direction: 'increase', target: 100000, unit: 'USD' },
        { name: 'churn', direction: 'decrease', target: null, unit: null },
      ],
    });
  });

  test('desugars each active pushed goal into exactly one reusable AGI cron trigger', () => {
    const loaded = extractTriggers(
      manifest(`  - slug: launch
    title: Launch the product
    done_when: Ten customers use the product for seven consecutive days.
    status: active
    push: "0 0 9 * * *"
    timezone: Europe/Berlin
`),
    );

    expect(loaded.errors).toEqual([]);
    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0]).toMatchObject({
      slug: goalPushTriggerSlug('launch'),
      path: 'kortix.yaml#goals.launch.push',
      name: 'Goal push: Launch the product',
      type: 'cron',
      agent: AGI_AGENT_NAME,
      platformAgiGoalPush: true,
      goalSlug: 'launch',
      enabled: true,
      cron: '0 0 9 * * *',
      timezone: 'Europe/Berlin',
      sessionMode: 'reuse',
      pinnedSessionId: null,
      sessionKey: null,
    });
    expect(loaded.specs[0]!.promptTemplate).toContain('Launch the product');
    expect(loaded.specs[0]!.promptTemplate).toContain(
      'Ten customers use the product for seven consecutive days.',
    );
    expect(loaded.specs[0]!.promptTemplate).toContain('Do not mark the goal achieved');
  });

  test('feeds the desugared trigger through the existing runtime catalog', async () => {
    const specs = extractTriggers(
      manifest(`  - slug: catalogued
    title: Catalogued
    done_when: Done
    status: active
    push: "0 0 9 * * *"
`),
    ).specs;
    const upserted: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [],
      upsert: async (_projectId, spec) => {
        upserted.push(spec.slug);
      },
      remove: async () => {},
    };

    await expect(
      reconcileProjectTriggerRuntimeWithStore('project-1', specs, store),
    ).resolves.toEqual({ upserted: 1, removed: 0 });
    expect(upserted).toEqual([goalPushTriggerSlug('catalogued')]);
  });

  test('does not schedule paused, achieved, abandoned, or push-less active goals', () => {
    const loaded = extractTriggers(
      manifest(`  - slug: paused
    title: Paused
    done_when: Done
    status: paused
    push: "0 0 9 * * *"
  - slug: achieved
    title: Achieved
    done_when: Done
    status: achieved
    push: "0 0 9 * * *"
  - slug: abandoned
    title: Abandoned
    done_when: Done
    status: abandoned
    push: "0 0 9 * * *"
  - slug: manual
    title: Manual
    done_when: Done
    status: active
`),
    );

    expect(loaded).toEqual({ specs: [], errors: [] });
  });

  test('uses an explicit goal agent instead of the reserved AGI agent', () => {
    const loaded = extractTriggers(
      manifest(`  - slug: delegated
    title: Delegated
    done_when: Done
    status: active
    push: "0 0 9 * * *"
    agent: worker
`),
    );

    expect(loaded.errors).toEqual([]);
    expect(loaded.specs[0]!.agent).toBe('worker');
    expect(loaded.specs[0]!.platformAgiGoalPush).toBeUndefined();
  });

  test('treats explicit agi as the reserved platform goal coordinator', () => {
    const loaded = extractTriggers(
      manifest(`  - slug: coordinated
    title: Coordinated
    done_when: Done
    status: active
    push: "0 0 9 * * *"
    agent: agi
`),
    );

    expect(loaded.errors).toEqual([]);
    expect(loaded.specs[0]).toMatchObject({
      agent: AGI_AGENT_NAME,
      platformAgiGoalPush: true,
    });
  });

  test('reports an explicit-trigger collision and does not overwrite either spec silently', () => {
    const generatedSlug = goalPushTriggerSlug('growth');
    const loaded = extractTriggers(
      manifest(
        `  - slug: growth
    title: Growth
    done_when: Revenue reaches 100000.
    status: active
    push: "0 0 9 * * *"
`,
        `triggers:
  - slug: ${generatedSlug}
    type: cron
    cron: "0 0 8 * * *"
    prompt: Explicit trigger
`,
      ),
    );

    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0]!.promptTemplate).toBe('Explicit trigger');
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toMatchObject({
      slug: generatedSlug,
      path: 'kortix.yaml#goals.growth.push',
    });
    expect(loaded.errors[0]!.error).toContain('collides with explicit trigger');
  });

  test('makes overlength generated slugs deterministic, legal, and distinct', () => {
    const prefix = 'a'.repeat(126);
    const first = goalPushTriggerSlug(`${prefix}1`);
    const second = goalPushTriggerSlug(`${prefix}2`);

    expect(first).toBe(goalPushTriggerSlug(`${prefix}1`));
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/);
    expect(second).not.toBe(first);
  });
});
