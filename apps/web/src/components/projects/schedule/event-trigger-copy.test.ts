import type { ProjectTriggerEvent } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  configProblem,
  configToDraft,
  connectorHref,
  defaultConfigDraft,
  defaultEventPrompt,
  describeEventStatus,
  describePollHint,
  draftToConfig,
  humanizeEventType,
  payloadVariables,
  schemaFields,
} from './event-trigger-copy';

const configSchema = {
  type: 'object',
  required: ['owner', 'repo'],
  properties: {
    owner: { type: 'string', description: 'Repository owner' },
    repo: { type: 'string' },
    limit: { type: 'integer', default: 10 },
    ratio: { type: 'number' },
    include_drafts: { type: 'boolean', default: false },
    state: { type: 'string', enum: ['open', 'closed'], default: 'open' },
    labels: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', properties: {} },
  },
};

describe('schemaFields', () => {
  const fields = schemaFields(configSchema);

  test('renders string, number, integer, boolean, enum and string-list fields, in order', () => {
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['owner', 'string'],
      ['repo', 'string'],
      ['limit', 'integer'],
      ['ratio', 'number'],
      ['include_drafts', 'boolean'],
      ['state', 'enum'],
      ['labels', 'list'],
    ]);
  });

  test('skips a property the form cannot render', () => {
    expect(fields.find((f) => f.key === 'nested')).toBeUndefined();
  });

  test('marks required fields and carries descriptions and enum options', () => {
    expect(fields[0]).toMatchObject({ required: true, description: 'Repository owner' });
    expect(fields.find((f) => f.key === 'ratio')?.required).toBe(false);
    expect(fields.find((f) => f.key === 'state')?.options).toEqual(['open', 'closed']);
  });

  test('an empty or missing schema gives no fields', () => {
    expect(schemaFields({})).toEqual([]);
    expect(schemaFields(null)).toEqual([]);
  });
});

describe('config draft', () => {
  const fields = schemaFields(configSchema);

  test('starts from schema defaults', () => {
    expect(defaultConfigDraft(fields)).toMatchObject({
      owner: '',
      limit: '10',
      include_drafts: 'false',
      state: 'open',
    });
  });

  test('a required empty field is the first problem', () => {
    expect(configProblem(fields, defaultConfigDraft(fields))).toBe('Owner is required.');
  });

  test('rejects a non-number and a fractional integer', () => {
    const base = { ...defaultConfigDraft(fields), owner: 'acme', repo: 'api' };
    expect(configProblem(fields, { ...base, ratio: 'abc' })).toBe('Ratio must be a number.');
    expect(configProblem(fields, { ...base, limit: '2.5' })).toBe('Limit must be a whole number.');
    expect(configProblem(fields, base)).toBeNull();
  });

  test('builds typed event_config and leaves empty fields out', () => {
    const draft = {
      ...defaultConfigDraft(fields),
      owner: ' acme ',
      repo: 'api',
      limit: '25',
      labels: 'bug\n\n  urgent ',
      include_drafts: 'true',
    };
    expect(draftToConfig(fields, draft)).toEqual({
      owner: 'acme',
      repo: 'api',
      limit: 25,
      include_drafts: true,
      state: 'open',
      labels: ['bug', 'urgent'],
    });
  });

  test('round-trips a saved config', () => {
    const saved = { owner: 'acme', repo: 'api', labels: ['bug', 'urgent'], limit: 5 };
    const draft = configToDraft(fields, saved);
    expect(draft.labels).toBe('bug\nurgent');
    expect(draftToConfig(fields, draft)).toMatchObject(saved);
  });
});

describe('delivery and prompt', () => {
  test('says how often a polled event checks, only when a default interval exists', () => {
    const base = { type: 'X', name: 'X', description: '', app: 'github', payload_schema: null };
    expect(
      describePollHint({
        ...base,
        delivery: 'poll',
        config_schema: { properties: { interval: { type: 'integer', default: 5 } } },
      }),
    ).toBe('Checks every 5 min');
    expect(describePollHint({ ...base, delivery: 'poll', config_schema: {} })).toBeNull();
    expect(
      describePollHint({
        ...base,
        delivery: 'push',
        config_schema: { properties: { interval: { default: 5 } } },
      }),
    ).toBeNull();
  });

  test('turns payload properties into template variables', () => {
    expect(
      payloadVariables({ properties: { title: { description: 'Title' }, number: {} } }),
    ).toEqual([
      { token: '{{ event.data.title }}', description: 'Title' },
      { token: '{{ event.data.number }}', description: null },
    ]);
    expect(payloadVariables(null)).toEqual([]);
  });

  test('prefills a prompt that carries the whole event', () => {
    expect(defaultEventPrompt({ name: 'New pull request', type: 'X' })).toContain(
      '{{ event.data }}',
    );
  });

  test('humanizes provider ids', () => {
    expect(humanizeEventType('GITHUB_PULL_REQUEST_EVENT')).toBe('Github pull request event');
  });
});

describe('status and links', () => {
  const event = (status: ProjectTriggerEvent['status'], error: string | null = null) =>
    ({
      connector: 'github',
      type: 'T',
      config: {},
      provider: 'composio',
      app: 'github',
      status,
      error,
      last_event_at: null,
    }) satisfies ProjectTriggerEvent;

  test('maps every wire status to a label', () => {
    expect(describeEventStatus(event('active')).label).toBe('Live');
    expect(describeEventStatus(event('needs_connection')).label).toBe('Needs connection');
    expect(describeEventStatus(event('error', 'boom'))).toMatchObject({
      label: 'Error',
      detail: 'boom',
    });
    expect(describeEventStatus(event('pending')).label).toBe('Activating');
  });

  test('needs_connection tells the person what to connect', () => {
    expect(describeEventStatus(event('needs_connection')).detail).toBe(
      'Connect a shared Github account to activate this trigger.',
    );
  });

  test('links to the connector detail on the Connectors page', () => {
    expect(connectorHref('p1', 'github')).toBe('/projects/p1/customize/connectors?c=github');
    expect(connectorHref('p1')).toBe('/projects/p1/customize/connectors');
  });
});
