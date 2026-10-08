import { describe, expect, test } from 'bun:test';
import { defaultTriggerSessionMode, extractTriggers, triggerSpecToTomlEntry } from '../triggers';
import type { ParsedManifest } from '../triggers';
import { draftToSpec, parseTriggerDraft, specToBody } from './trigger-draft';

const manifest = (triggers: unknown[]): ParsedManifest => ({
  schemaVersion: 2,
  raw: { triggers },
  format: 'yaml',
  path: 'kortix.yaml',
});

const entry = {
  slug: 'pr-review',
  type: 'event',
  connector: 'github',
  event: 'GITHUB_PULL_REQUEST_EVENT',
  config: { owner: 'acme', repo: 'api' },
  prompt: 'Review {{ event.data.pull_request.html_url }}',
};

describe('event trigger entry', () => {
  test('parses and defaults to a fresh session', () => {
    const { specs, errors } = extractTriggers(manifest([entry]));
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      type: 'event',
      cron: null,
      secretEnv: null,
      sessionMode: 'fresh',
      event: { connector: 'github', type: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme', repo: 'api' } },
    });
    expect(defaultTriggerSessionMode('event')).toBe('fresh');
  });

  test('parse -> serialize -> parse round trip is stable', () => {
    const first = extractTriggers(manifest([entry])).specs[0]!;
    const out = triggerSpecToTomlEntry(first);
    expect(out).toMatchObject({ type: 'event', connector: 'github', event: 'GITHUB_PULL_REQUEST_EVENT' });
    expect(out.cron).toBeUndefined();
    expect(out.timezone).toBeUndefined();
    expect(extractTriggers(manifest([out])).specs[0]).toEqual(first);
  });

  test('config is optional and omitted from the entry when empty', () => {
    const { config: _drop, ...bare } = entry;
    const spec = extractTriggers(manifest([bare])).specs[0]!;
    expect(spec.event?.config).toEqual({});
    expect(triggerSpecToTomlEntry(spec).config).toBeUndefined();
  });

  test('account is optional, trimmed, serialized only when set, and round-trips', () => {
    const bare = extractTriggers(manifest([entry])).specs[0]!;
    expect(bare.event).not.toHaveProperty('account');
    expect(triggerSpecToTomlEntry(bare).account).toBeUndefined();
    const spec = extractTriggers(manifest([{ ...entry, account: ' acme-bot ' }])).specs[0]!;
    expect(spec.event?.account).toBe('acme-bot');
    const out = triggerSpecToTomlEntry(spec);
    expect(out).toMatchObject({ connector: 'github', account: 'acme-bot' });
    expect(extractTriggers(manifest([out])).specs[0]).toEqual(spec);
  });

  test.each([
    [{ connector: undefined }, 'connector'],
    [{ account: '  ' }, 'account must be the label'],
    [{ account: 7 }, 'account must be the label'],
    [{ event: undefined }, 'event'],
    [{ config: 'nope' }, 'config must be an object'],
    [{ cron: '0 0 9 * * *' }, 'cron is not valid on an event trigger'],
    [{ secret_env: 'HOOK_SECRET' }, 'secret_env is not valid on an event trigger'],
    [{ mode: 'poll' }, 'mode is not valid on an event trigger'],
  ])('rejects %j', (patch, message) => {
    const { errors } = extractTriggers(manifest([{ ...entry, ...patch }]));
    expect(errors[0]?.error).toContain(message);
  });

  test('rejects account on a cron trigger', () => {
    const { errors } = extractTriggers(
      manifest([{ slug: 'c', type: 'cron', cron: '0 0 9 * * *', prompt: 'x', account: 'acme-bot' }]),
    );
    expect(errors[0]?.error).toContain('account is only valid on an event trigger');
  });

  test('rejects event keys on a cron trigger', () => {
    const { errors } = extractTriggers(
      manifest([{ slug: 'c', type: 'cron', cron: '0 0 9 * * *', prompt: 'x', connector: 'github' }]),
    );
    expect(errors[0]?.error).toContain('connector is only valid on an event trigger');
  });
});

describe('event trigger draft', () => {
  const body = {
    name: 'PR review',
    type: 'event',
    connector: 'github',
    event: 'GITHUB_PULL_REQUEST_EVENT',
    event_config: { owner: 'acme' },
    prompt_template: 'Review it',
  };

  test('parses to an event draft and spec', () => {
    const draft = parseTriggerDraft(body, { existingSlug: null });
    if ('error' in draft) throw new Error(draft.error);
    expect(draft).toMatchObject({ type: 'event', sessionMode: 'fresh', event: { connector: 'github', config: { owner: 'acme' } } });
    const spec = draftToSpec(draft);
    expect(spec.event).toEqual({ connector: 'github', type: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme' } });
  });

  test('event_account sets the account; null or absent leaves the connector default', () => {
    const parse = (extra: Record<string, unknown>) => {
      const draft = parseTriggerDraft({ ...body, ...extra }, { existingSlug: null });
      if ('error' in draft) throw new Error(draft.error);
      return draftToSpec(draft).event;
    };
    expect(parse({ event_account: 'acme-bot' })).toEqual({
      connector: 'github', account: 'acme-bot', type: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme' },
    });
    expect(parse({ event_account: null })).not.toHaveProperty('account');
    expect(parse({})).not.toHaveProperty('account');
  });

  test('PATCH merge keeps the account, and event_account: null clears it', () => {
    const draft = parseTriggerDraft({ ...body, event_account: 'acme-bot' }, { existingSlug: null });
    if ('error' in draft) throw new Error(draft.error);
    const base = specToBody(draftToSpec(draft));
    expect(base.event_account).toBe('acme-bot');
    const kept = parseTriggerDraft({ ...base, event_config: { owner: 'x' } }, { existingSlug: draft.slug });
    expect(kept).toMatchObject({ event: { account: 'acme-bot' } });
    const cleared = parseTriggerDraft({ ...base, event_account: null }, { existingSlug: draft.slug });
    if ('error' in cleared) throw new Error(cleared.error);
    expect(cleared.event).not.toHaveProperty('account');
  });

  test('rejects event_account on a webhook draft', () => {
    const draft = parseTriggerDraft(
      { name: 'W', type: 'webhook', secret_env: 'S', prompt_template: 'x', event_account: 'a' },
      { existingSlug: null },
    );
    expect('error' in draft && draft.error).toContain('event_account is only valid on an event trigger');
  });

  test('PATCH merge body re-parses to the same draft', () => {
    const draft = parseTriggerDraft(body, { existingSlug: null });
    if ('error' in draft) throw new Error(draft.error);
    const merged = parseTriggerDraft(
      { ...specToBody(draftToSpec(draft)), event_config: { owner: 'other' } },
      { existingSlug: draft.slug },
    );
    expect(merged).toMatchObject({ type: 'event', event: { config: { owner: 'other' } } });
  });

  test.each([
    [{ connector: undefined }, 'connector'],
    [{ event: '' }, 'event'],
    [{ event_config: [] }, 'event_config must be an object'],
    [{ cron: '0 0 9 * * *' }, 'cron is not valid'],
  ])('rejects %j', (patch, message) => {
    const draft = parseTriggerDraft({ ...body, ...patch }, { existingSlug: null });
    expect('error' in draft && draft.error).toContain(message);
  });

  test('rejects event keys on a webhook draft', () => {
    const draft = parseTriggerDraft(
      { name: 'W', type: 'webhook', secret_env: 'S', prompt_template: 'x', connector: 'github' },
      { existingSlug: null },
    );
    expect('error' in draft && draft.error).toContain('connector is only valid on an event trigger');
  });
});
