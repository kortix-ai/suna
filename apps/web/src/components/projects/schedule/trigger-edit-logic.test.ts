import { describe, expect, test } from 'bun:test';
import type { ProjectTrigger, ProjectTriggerEventType } from '@kortix/sdk';

import { draftFromTrigger, triggerPatch } from './trigger-edit-logic';

function trigger(overrides: Partial<ProjectTrigger> = {}): ProjectTrigger {
  return {
    slug: 'triage',
    path: 'kortix.yaml#triggers.triage',
    name: 'Inbox triage',
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    cron: '0 0 9 * * *',
    run_at: null,
    timezone: 'UTC',
    secret_env: null,
    prompt_template: 'Triage the inbox',
    session_mode: 'fresh',
    session_id: null,
    session_key: null,
    filter: null,
    session_access: { mode: 'private', memberIds: [], groupIds: [] },
    last_fired_at: null,
    webhook_url: null,
    event: null,
    ...overrides,
  } as ProjectTrigger;
}

const eventType = (over: Partial<ProjectTriggerEventType> = {}): ProjectTriggerEventType => ({
  type: 'GITHUB_COMMIT_EVENT',
  name: 'Commit',
  description: '',
  app: 'github',
  delivery: 'poll',
  config_schema: {
    type: 'object',
    required: ['repo'],
    properties: { repo: { type: 'string' }, limit: { type: 'integer', default: 10 } },
  },
  payload_schema: null,
  ...over,
});

const eventTrigger = (over: Partial<NonNullable<ProjectTrigger['event']>> = {}) =>
  trigger({
    type: 'event',
    cron: null,
    event: {
      connector: 'github-work',
      account: null,
      type: 'GITHUB_COMMIT_EVENT',
      config: { repo: 'acme/api' },
      provider: 'composio',
      app: 'github',
      status: 'active',
      error: null,
      last_event_at: null,
      ...over,
    },
  });

const saved = (t: ProjectTrigger, et: ProjectTriggerEventType | null = null) =>
  draftFromTrigger(t, { eventType: et, model: null });

describe('triggerPatch: only what changed', () => {
  test('an untouched draft patches nothing', () => {
    const base = saved(trigger());
    expect(triggerPatch(base, { ...base })).toEqual({});
    const ev = saved(eventTrigger(), eventType());
    expect(triggerPatch(ev, { ...ev })).toEqual({});
  });

  test('instruction and name travel alone', () => {
    const base = saved(trigger());
    expect(triggerPatch(base, { ...base, instruction: 'Triage and label' })).toEqual({
      prompt_template: 'Triage and label',
    });
    expect(triggerPatch(base, { ...base, nameOverride: '  Renamed ' })).toEqual({ name: 'Renamed' });
  });

  test('two changed fields make one payload with both', () => {
    const base = saved(eventTrigger(), eventType());
    expect(
      triggerPatch(base, { ...base, instruction: 'New words', account: 'acme-bot' }),
    ).toEqual({ prompt_template: 'New words', event_account: 'acme-bot' });
  });

  test('a schedule edit clears the field it replaces', () => {
    const base = saved(trigger());
    expect(triggerPatch(base, { ...base, cron: '0 0 8 * * *' })).toEqual({
      cron: '0 0 8 * * *',
      run_at: null,
      timezone: 'UTC',
    });
    expect(triggerPatch(base, { ...base, runAt: '2030-01-01T09:00:00.000Z' })).toEqual({
      run_at: '2030-01-01T09:00:00.000Z',
      cron: null,
      timezone: 'UTC',
    });
  });

  test('a webhook sends its secret name, and conditions only on non-schedules', () => {
    const base = saved(trigger({ type: 'webhook', cron: null, secret_env: 'OLD_SECRET' }));
    expect(triggerPatch(base, { ...base, secretName: 'NEW_SECRET' })).toEqual({ secret_env: 'NEW_SECRET' });
    expect(
      triggerPatch(base, { ...base, conditions: [{ path: 'body.kind', value: 'push' }] }),
    ).toEqual({ filter: { 'body.kind': 'push' } });
    const cron = saved(trigger());
    expect(triggerPatch(cron, { ...cron, conditions: [{ path: 'a', value: 'b' }] })).toEqual({});
  });

  test('run location: a mode carries only the value it needs', () => {
    const base = saved(trigger());
    expect(triggerPatch(base, { ...base, mode: 'reuse' })).toEqual({
      session_mode: 'reuse',
      session_id: null,
      session_key: null,
    });
    expect(triggerPatch(base, { ...base, mode: 'pinned', pinnedSessionId: 's1' })).toEqual({
      session_mode: 'pinned',
      session_id: 's1',
      session_key: null,
    });
    expect(triggerPatch(base, { ...base, mode: 'keyed', sessionKey: ' {{ body.chat }} ' })).toEqual({
      session_mode: 'keyed',
      session_key: '{{ body.chat }}',
      session_id: null,
    });
  });

  test('agent, model and session access', () => {
    const base = saved(trigger());
    const model = { providerID: 'anthropic', modelID: 'm1' };
    const patch = triggerPatch(base, {
      ...base,
      agent: 'build',
      model,
      sessionAccess: { mode: 'project', memberIds: [], groupIds: [] },
    });
    expect(patch.agent).toBe('build');
    expect(patch.model).toBe('anthropic/m1');
    expect(patch.session_access).toEqual({ mode: 'project', memberIds: [], groupIds: [] });
    expect(triggerPatch({ ...base, model }, { ...base, model: null }).model).toBeNull();
  });
});

describe('triggerPatch: an app event', () => {
  const base = saved(eventTrigger(), eventType());

  test('event settings send the whole event_config', () => {
    expect(triggerPatch(base, { ...base, configDraft: { repo: 'acme/web', limit: '10' } })).toEqual({
      event_config: { repo: 'acme/web', limit: 10 },
    });
  });

  test('a new event sends its type and a fresh config', () => {
    const next = eventType({ type: 'GITHUB_PULL_REQUEST_EVENT', config_schema: { properties: {} } });
    expect(triggerPatch(base, { ...base, eventType: next, configDraft: {} })).toEqual({
      event: 'GITHUB_PULL_REQUEST_EVENT',
      event_config: {},
    });
  });

  test('another connector sends the connector with its account, so the old account never carries over', () => {
    expect(triggerPatch(base, { ...base, profile: 'github', account: null })).toEqual({
      connector: 'github',
      event_account: null,
    });
    expect(triggerPatch(base, { ...base, profile: 'github', account: 'ci' })).toEqual({
      connector: 'github',
      event_account: 'ci',
    });
  });

  test('an event the catalog lacks keeps its saved config and sends nothing unless edited', () => {
    const stub = saved(eventTrigger());
    expect(stub.eventType?.type).toBe('GITHUB_COMMIT_EVENT');
    expect(triggerPatch(stub, { ...stub, instruction: 'x' })).toEqual({ prompt_template: 'x' });
  });
});
