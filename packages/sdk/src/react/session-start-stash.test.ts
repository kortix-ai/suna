import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as any).sessionStorage = new MemoryStorage();
});

afterEach(() => {
  delete (globalThis as any).sessionStorage;
});

import {
  START_STASH_TTL_MS,
  clearStartStash,
  migrateLegacyStash,
  migrateStash,
  readStartStash,
  startStashKey,
  writeStartStash,
} from './session-start-stash';

describe('writeStartStash / readStartStash', () => {
  test('round-trips the modern stash shape', () => {
    writeStartStash('ses_1', {
      prompt: 'hello',
      model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
      agent: 'build',
      variant: 'thinking',
    });

    expect(readStartStash('ses_1')).toEqual({
      prompt: 'hello',
      model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
      agent: 'build',
      variant: 'thinking',
    });
  });

  test('returns null when nothing is stashed', () => {
    expect(readStartStash('ses_missing')).toBeNull();
  });

  test('drops stale Auto selections on write and read', () => {
    writeStartStash('ses_auto_write', {
      prompt: 'hello',
      model: { providerID: 'kortix', modelID: 'auto' },
      agent: null,
    });
    expect(readStartStash('ses_auto_write')?.model).toBeNull();

    sessionStorage.setItem(
      startStashKey('ses_auto_read'),
      JSON.stringify({
        prompt: 'hello',
        model: { providerID: 'kortix', modelID: 'kortix/auto' },
        agent: null,
      }),
    );
    expect(readStartStash('ses_auto_read')?.model).toBeNull();
  });

  test('clearStartStash removes the modern key', () => {
    writeStartStash('ses_1', { prompt: 'hi', model: null, agent: null });
    clearStartStash('ses_1');
    expect(sessionStorage.getItem(startStashKey('ses_1'))).toBeNull();
    expect(readStartStash('ses_1')).toBeNull();
  });
});

describe('readStartStash legacy compatibility', () => {
  // Several web "new session" producers (dashboard, workspace, legacy composer)
  // still write the pre-SDK shape directly: a bare prompt string under
  // `opencode_pending_prompt:<id>` plus an optional JSON options blob under
  // `opencode_pending_options:<id>`. Those call sites are out of scope for this
  // migration, so the SDK's read path must understand both shapes.
  test('reads a legacy bare prompt with no options', () => {
    sessionStorage.setItem('opencode_pending_prompt:ses_2', 'do the thing');
    expect(readStartStash('ses_2')).toEqual({
      prompt: 'do the thing',
      model: null,
      agent: null,
      variant: null,
    });
  });

  test('reads legacy options (object model + agent + variant)', () => {
    sessionStorage.setItem('opencode_pending_prompt:ses_3', 'do the thing');
    sessionStorage.setItem(
      'opencode_pending_options:ses_3',
      JSON.stringify({
        agent: 'build',
        model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
        variant: 'thinking',
      }),
    );
    expect(readStartStash('ses_3')).toEqual({
      prompt: 'do the thing',
      model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
      agent: 'build',
      variant: 'thinking',
    });
  });

  test('parses a legacy string model ("provider/model")', () => {
    sessionStorage.setItem('opencode_pending_prompt:ses_4', 'do the thing');
    sessionStorage.setItem(
      'opencode_pending_options:ses_4',
      JSON.stringify({ model: 'anthropic/claude-opus' }),
    );
    expect(readStartStash('ses_4')?.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus',
    });
  });

  test('the modern stash wins over a legacy one under the same id', () => {
    sessionStorage.setItem('opencode_pending_prompt:ses_5', 'legacy prompt');
    writeStartStash('ses_5', { prompt: 'modern prompt', model: null, agent: null });
    expect(readStartStash('ses_5')?.prompt).toBe('modern prompt');
  });

  test('clearStartStash removes both the modern and legacy keys', () => {
    sessionStorage.setItem('opencode_pending_prompt:ses_6', 'legacy prompt');
    sessionStorage.setItem('opencode_pending_options:ses_6', JSON.stringify({ agent: 'build' }));
    writeStartStash('ses_6', { prompt: 'modern prompt', model: null, agent: null });

    clearStartStash('ses_6');

    expect(sessionStorage.getItem('opencode_pending_prompt:ses_6')).toBeNull();
    expect(sessionStorage.getItem('opencode_pending_options:ses_6')).toBeNull();
    expect(readStartStash('ses_6')).toBeNull();
  });
});

describe('migrateLegacyStash', () => {
  test('moves a differently-keyed prompt + options onto the canonical stash', () => {
    sessionStorage.setItem('project_pending_prompt:proj-ses-1', 'build me a widget');
    sessionStorage.setItem(
      'project_pending_options:proj-ses-1',
      JSON.stringify({ agent: 'build', model: { providerID: 'kortix', modelID: 'glm-5.3-flash' } }),
    );

    migrateLegacyStash(
      'project_pending_prompt:proj-ses-1',
      'project_pending_options:proj-ses-1',
      'oc_target',
    );

    expect(readStartStash('oc_target')).toEqual({
      prompt: 'build me a widget',
      model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
      agent: 'build',
      variant: null,
    });
    // Source keys are always cleared.
    expect(sessionStorage.getItem('project_pending_prompt:proj-ses-1')).toBeNull();
    expect(sessionStorage.getItem('project_pending_options:proj-ses-1')).toBeNull();
  });

  test('is a no-op when there is nothing stashed at the source', () => {
    migrateLegacyStash('project_pending_prompt:none', 'project_pending_options:none', 'oc_target2');
    expect(readStartStash('oc_target2')).toBeNull();
  });

  test('never clobbers a stash the target already has', () => {
    writeStartStash('oc_target3', { prompt: 'already here', model: null, agent: null });
    sessionStorage.setItem('project_pending_prompt:proj-ses-3', 'a different prompt');

    migrateLegacyStash(
      'project_pending_prompt:proj-ses-3',
      'project_pending_options:proj-ses-3',
      'oc_target3',
    );

    expect(readStartStash('oc_target3')?.prompt).toBe('already here');
    // Source keys are still cleared even when the migration was skipped.
    expect(sessionStorage.getItem('project_pending_prompt:proj-ses-3')).toBeNull();
  });
});

describe('migrateStash', () => {
  // Producers that already write the canonical shape (writeStartStash) key it
  // by a route/project id before the real OpenCode session id exists; a later
  // render resolves the real id and needs to hand the stash off. Unlike
  // `migrateLegacyStash` (which only understands a raw bare-prompt + options
  // pair at arbitrary keys), `migrateStash` reads the source via
  // `readStartStash`, so it understands a canonical JSON stash as the source.
  test('moves a canonical stash from one session id to another', () => {
    writeStartStash('route_1', {
      prompt: 'build me a widget',
      model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
      agent: 'build',
      variant: 'thinking',
    });

    migrateStash('route_1', 'oc_1');

    expect(readStartStash('oc_1')).toEqual({
      prompt: 'build me a widget',
      model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
      agent: 'build',
      variant: 'thinking',
    });
    // Source is always cleared, canonical key included.
    expect(sessionStorage.getItem(startStashKey('route_1'))).toBeNull();
    expect(readStartStash('route_1')).toBeNull();
  });

  test('moves a canonical stash with only some options set', () => {
    writeStartStash('route_2', { prompt: 'do a thing', model: null, agent: 'plan' });

    migrateStash('route_2', 'oc_2');

    expect(readStartStash('oc_2')).toEqual({
      prompt: 'do a thing',
      model: null,
      agent: 'plan',
    });
  });

  test('a legacy bare-prompt source still migrates', () => {
    sessionStorage.setItem('opencode_pending_prompt:route_3', 'legacy prompt');
    sessionStorage.setItem(
      'opencode_pending_options:route_3',
      JSON.stringify({ agent: 'build', variant: 'thinking' }),
    );

    migrateStash('route_3', 'oc_3');

    expect(readStartStash('oc_3')).toEqual({
      prompt: 'legacy prompt',
      model: null,
      agent: 'build',
      variant: 'thinking',
    });
    // Both the canonical and legacy source keys are cleared.
    expect(sessionStorage.getItem(startStashKey('route_3'))).toBeNull();
    expect(sessionStorage.getItem('opencode_pending_prompt:route_3')).toBeNull();
    expect(sessionStorage.getItem('opencode_pending_options:route_3')).toBeNull();
  });

  test('source is always cleared, even when there is nothing to migrate', () => {
    migrateStash('route_missing', 'oc_missing');
    expect(readStartStash('oc_missing')).toBeNull();
    expect(sessionStorage.getItem(startStashKey('route_missing'))).toBeNull();
  });

  test('never clobbers a stash the target already has', () => {
    writeStartStash('oc_4', { prompt: 'already here', model: null, agent: null });
    writeStartStash('route_4', { prompt: 'a different prompt', model: null, agent: null });

    migrateStash('route_4', 'oc_4');

    expect(readStartStash('oc_4')?.prompt).toBe('already here');
    // Source is still cleared even when the migration was skipped.
    expect(readStartStash('route_4')).toBeNull();
  });
});

describe('start-stash age bound', () => {
  // Regression guard: a stash restored by a failed replay (or never consumed
  // because the session page never mounted) used to live for the tab's whole
  // life — reopening that session days later auto-sent the stale prompt into
  // its by-then-real conversation. A stash is a hand-off for THIS navigation,
  // so one older than the delivery-starvation bound is dead, not pending.
  test('a stash older than the TTL reads as null and is cleared', () => {
    const stale = Date.now() - START_STASH_TTL_MS - 1;
    sessionStorage.setItem(
      startStashKey('ses_ttl'),
      JSON.stringify({ prompt: 'old prompt', model: null, agent: null, at: stale }),
    );

    expect(readStartStash('ses_ttl')).toBeNull();
    expect(sessionStorage.getItem(startStashKey('ses_ttl'))).toBeNull();
  });

  test('a stash within the TTL still reads', () => {
    const fresh = Date.now() - 1000;
    sessionStorage.setItem(
      startStashKey('ses_ttl2'),
      JSON.stringify({ prompt: 'recent prompt', model: null, agent: null, at: fresh }),
    );

    expect(readStartStash('ses_ttl2')?.prompt).toBe('recent prompt');
  });

  test('writeStartStash stamps the write time', () => {
    const before = Date.now();
    writeStartStash('ses_ttl3', { prompt: 'p', model: null, agent: null });
    const raw = JSON.parse(sessionStorage.getItem(startStashKey('ses_ttl3')) ?? '{}') as {
      at?: number;
    };
    expect(typeof raw.at).toBe('number');
    expect(raw.at as number).toBeGreaterThanOrEqual(before);
  });

  test('a stash without a stamp (pre-TTL producer, legacy shape) is treated as fresh', () => {
    sessionStorage.setItem(
      startStashKey('ses_ttl4'),
      JSON.stringify({ prompt: 'unstamped', model: null, agent: null }),
    );
    expect(readStartStash('ses_ttl4')?.prompt).toBe('unstamped');

    sessionStorage.setItem('opencode_pending_prompt:ses_ttl5', 'legacy prompt');
    expect(readStartStash('ses_ttl5')?.prompt).toBe('legacy prompt');
  });
});

describe('picks-only stashes (empty prompt)', () => {
  // apps/web's producers deliver the first prompt as a durable inbox row and
  // hand off ONLY the picks through the stash. An empty prompt must therefore
  // round-trip — a null here would drop the model/agent hand-off with it.
  test('an empty-prompt stash round-trips its picks', () => {
    writeStartStash('ses-picks', {
      prompt: '',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      agent: 'default',
      variant: 'high',
    });

    expect(readStartStash('ses-picks')).toEqual({
      prompt: '',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      agent: 'default',
      variant: 'high',
    });
  });
});
