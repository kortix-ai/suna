import { describe, expect, test } from 'bun:test';
import { parseReminderPrompt } from '@kortix/shared';
import type { GitTriggerSpec } from '../triggers';
import {
  triggerSourceOf,
  triggerTargetOf,
  changeRequestMatches,
  isRuntimeTriggerSlug,
  newRuntimeTriggerId,
  parseRuntimeTriggerBody,
  runtimeTriggerSpec,
  serializeRuntimeTrigger,
} from './runtime-triggers';
import { reminderPromptText, reminderSpec, parseReminderDraft, serializeSessionReminder } from './session-reminders';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const SESSION = '00000000-0000-4000-a000-00000000aa01';
const CR = '00000000-0000-4000-a000-00000000cc01';

function spec(fields: Partial<GitTriggerSpec>): GitTriggerSpec {
  return {
    slug: 'nightly', path: 'kortix.yaml#triggers.nightly', name: 'nightly', type: 'cron', agent: 'default',
    model: null, enabled: true, promptTemplate: 'x', cron: '0 0 9 * * *', runAt: null, timezone: 'UTC',
    secretEnv: null, sessionMode: 'fresh', pinnedSessionId: null, sessionKey: null, filter: null,
    ...fields,
  };
}

function parsed(body: Record<string, unknown>) {
  const result = parseRuntimeTriggerBody(body, NOW);
  if ('error' in result) throw new Error(result.error);
  return result;
}

describe('trigger source and target', () => {
  test('a trigger type maps to its source; cron is the schedule source', () => {
    expect(triggerSourceOf('cron')).toBe('schedule');
    expect(triggerSourceOf('webhook')).toBe('webhook');
    expect(triggerSourceOf('event')).toBe('event');
    expect(triggerSourceOf('app')).toBe('app');
    expect(triggerSourceOf('change_request')).toBe('change_request');
  });

  test('the target reads the row, not the slug', () => {
    expect(triggerTargetOf(spec({}))).toEqual({ kind: 'agent', agent: 'default' });
    expect(triggerTargetOf(spec({ target: { app: 'site', path: '/', method: 'POST' } }))).toEqual({ kind: 'app', app: 'site' });
    // A session-target row with a slug that is not `reminder.<hex>` is still a session target.
    const woken = spec({ slug: 'trigger.0123456789ab', type: 'webhook', sessionMode: 'pinned', pinnedSessionId: SESSION, reminder: { everySeconds: null, createdAt: NOW.toISOString() } });
    expect(triggerTargetOf(woken)).toEqual({ kind: 'session', session_id: SESSION });
    // A kortix.yaml trigger pinned to a session falls back to a new session: it targets its agent.
    expect(triggerTargetOf(spec({ sessionMode: 'pinned', pinnedSessionId: SESSION }))).toEqual({ kind: 'agent', agent: 'default' });
  });

  test('runtime slugs: reminder and trigger ids (and pre-rename automation ids), never a manifest slug or an App run', () => {
    expect(newRuntimeTriggerId()).toMatch(/^trigger\.[0-9a-f]{12}$/);
    expect(isRuntimeTriggerSlug(newRuntimeTriggerId())).toBe(true);
    expect(isRuntimeTriggerSlug('reminder.0123456789ab')).toBe(true);
    expect(isRuntimeTriggerSlug('trigger.0123456789ab')).toBe(true);
    expect(isRuntimeTriggerSlug('nightly')).toBe(false);
    expect(isRuntimeTriggerSlug('apprun.0123456789ab')).toBe(false);
    expect(isRuntimeTriggerSlug('trigger.XYZ')).toBe(false);
  });
});

describe('changeRequestMatches', () => {
  const merged = { cr_id: CR, base_ref: 'main' };
  test('no filter matches every merge', () => {
    expect(changeRequestMatches(spec({ type: 'change_request', changeRequest: { crId: null, base: null } }), merged)).toBe(true);
  });
  test('cr_id and base narrow it', () => {
    expect(changeRequestMatches(spec({ type: 'change_request', changeRequest: { crId: CR, base: null } }), merged)).toBe(true);
    expect(changeRequestMatches(spec({ type: 'change_request', changeRequest: { crId: 'other', base: null } }), merged)).toBe(false);
    expect(changeRequestMatches(spec({ type: 'change_request', changeRequest: { crId: null, base: 'dev' } }), merged)).toBe(false);
  });
  test('another source type never matches', () => {
    expect(changeRequestMatches(spec({}), merged)).toBe(false);
  });
});

describe('parseRuntimeTriggerBody', () => {
  test('a target is required: session or agent, not both', () => {
    expect(parseRuntimeTriggerBody({ prompt: 'x', source: { type: 'webhook', secret_env: 'S' } }, NOW)).toEqual({ error: 'target is required: { session_id } or { agent }' });
    expect(parseRuntimeTriggerBody({ prompt: 'x', source: { type: 'webhook', secret_env: 'S' }, target: { session_id: SESSION, agent: 'a' } }, NOW)).toEqual({ error: 'target takes session_id or agent, not both' });
  });

  test('schedule into a session parses with the loop rules (5 min floor)', () => {
    const body = parsed({ prompt: 'check', source: { type: 'schedule', every: '1h' }, target: { session_id: SESSION } });
    expect(body.target).toEqual({ kind: 'session', session_id: SESSION });
    expect(body.reminderDraft?.everySeconds).toBe(3600);
    expect(parseRuntimeTriggerBody({ prompt: 'x', source: { type: 'schedule', every: '1m' }, target: { session_id: SESSION } }, NOW)).toEqual({ error: 'every must be at least 5m' });
  });

  test('a change_request source takes an optional cr_id and base', () => {
    const body = parsed({ prompt: 'merged {{ change_request.number }}', source: { type: 'change_request', cr_id: CR }, target: { session_id: SESSION } });
    expect(body.triggerBody).toMatchObject({ type: 'change_request', cr_id: CR, base: null });
  });

  test('an unknown source type is refused', () => {
    expect(parseRuntimeTriggerBody({ prompt: 'x', source: { type: 'email' }, target: { agent: 'a' } }, NOW)).toEqual({
      error: 'source.type must be one of schedule, webhook, event, app, change_request',
    });
  });
});

describe('runtimeTriggerSpec', () => {
  test('a webhook into a session is a session target with no schedule', () => {
    const body = parsed({ prompt: 'Build {{ body.ref }}', name: 'ci', source: { type: 'webhook', secret_env: 'CI_SECRET' }, target: { session_id: SESSION } });
    const built = runtimeTriggerSpec({ id: 'trigger.0123456789ab', body, agent: 'kortix', now: NOW, promptAuthorUserId: 'u1' });
    if ('error' in built) throw new Error(built.error);
    expect(built).toMatchObject({
      slug: 'trigger.0123456789ab', type: 'webhook', secretEnv: 'CI_SECRET', agent: 'kortix', name: 'ci',
      sessionMode: 'pinned', pinnedSessionId: SESSION, cron: null, runAt: null,
      reminder: { everySeconds: null, createdAt: NOW.toISOString(), promptAuthorUserId: 'u1' },
    });
  });

  test('a change request into an agent starts a fresh session per fire', () => {
    const body = parsed({ prompt: 'Write release notes', source: { type: 'change_request', base: 'main' }, target: { agent: 'writer' } });
    const built = runtimeTriggerSpec({ id: 'trigger.0123456789ab', body, agent: 'writer', now: NOW });
    if ('error' in built) throw new Error(built.error);
    expect(built).toMatchObject({ type: 'change_request', agent: 'writer', sessionMode: 'fresh', changeRequest: { crId: null, base: 'main' } });
    expect(built.reminder).toBeUndefined();
  });

  test('a schedule into a session is the loop spec, under the trigger id', () => {
    const body = parsed({ prompt: 'check', source: { type: 'schedule', in: '2h' }, target: { session_id: SESSION } });
    const built = runtimeTriggerSpec({ id: 'trigger.0123456789ab', body, agent: 'kortix', now: NOW });
    if ('error' in built) throw new Error(built.error);
    const draft = parseReminderDraft({ prompt: 'check', in: '2h' }, NOW);
    if ('error' in draft) throw new Error(draft.error);
    expect(built).toEqual(reminderSpec({ id: 'trigger.0123456789ab', sessionId: SESSION, agent: 'kortix', draft, now: NOW }));
  });
});

describe('session-target rows from a non-schedule source', () => {
  const row = (fields: Record<string, unknown>) => ({
    slug: 'trigger.0123456789ab',
    sessionId: SESSION,
    scheduleSpec: spec({ slug: 'trigger.0123456789ab', type: 'webhook', secretEnv: 'S', sessionMode: 'pinned', pinnedSessionId: SESSION, reminder: { everySeconds: null, createdAt: NOW.toISOString() } }),
    enabled: true, nextFireAt: null, lastScheduledFor: null, lastFiredAt: null, lastStatus: null, lastError: null, ownerUserId: null,
    triggerType: 'webhook',
    ...fields,
  }) as unknown as Parameters<typeof serializeSessionReminder>[0];

  test('an enabled runtime webhook trigger is active, not done: it has no next fire by design', () => {
    expect(serializeSessionReminder(row({})).state).toBe('active');
    expect(serializeSessionReminder(row({ enabled: false })).state).toBe('paused');
  });

  test('the serialized runtime trigger names its source and target', () => {
    expect(serializeRuntimeTrigger(row({}), 'Fix the build')).toMatchObject({
      id: 'trigger.0123456789ab', origin: 'runtime', state: 'active',
      source: { type: 'webhook', secret_env: 'S' },
      target: { kind: 'session', session_id: SESSION, session_name: 'Fix the build' },
    });
  });

  test('its fire delivers the rendered prompt under a header the UI parses', () => {
    const woken = row({}).scheduleSpec as unknown as GitTriggerSpec;
    const text = reminderPromptText(woken, 'Build main');
    expect(text).toBe(
      '[REMINDER trigger.0123456789ab — recurring trigger (webhook) on this session, not a new user message. When it is no longer needed, run `kortix triggers rm trigger.0123456789ab`.]\n\nBuild main',
    );
    expect(parseReminderPrompt(text)).toEqual({ id: 'trigger.0123456789ab', recurring: true, prompt: 'Build main' });
  });
});
