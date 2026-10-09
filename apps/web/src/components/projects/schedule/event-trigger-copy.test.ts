import type {
  ProjectTrigger,
  ProjectTriggerEvent,
  ProjectTriggerEventApp,
  ProjectTriggerEventConnector,
} from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
import {
  accountToStore,
  appConnectors,
  configProblem,
  configToDraft,
  connectorHref,
  defaultConfigDraft,
  defaultEventPrompt,
  describeAccount,
  describeEventTitle,
  eventAppName,
  fallbackAccount,
  accountToWrite,
  indexEventApps,
  describeEventSource,
  describeEventStatus,
  eventSourceName,
  eventTriggersOn,
  describePollHint,
  draftToConfig,
  groupEventApps,
  humanizeEventType,
  newConnectorSlug,
  parseConfigErrors,
  payloadVariables,
  profileConnected,
  selectedAccountLabel,
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
      { field: 'title', token: '{{ event.data.title }}', description: 'Title' },
      { field: 'number', token: '{{ event.data.number }}', description: null },
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
    expect(describeEventStatus(event('active'), testUiTranslator).label).toBe('Live');
    expect(describeEventStatus(event('needs_connection'), testUiTranslator).label).toBe(
      'Needs connection',
    );
    expect(describeEventStatus(event('error', 'boom'), testUiTranslator)).toMatchObject({
      label: 'Error',
      detail: 'boom',
    });
    expect(describeEventStatus(event('pending'), testUiTranslator).label).toBe('Activating');
  });

  test('the app in the detail is the catalog name, else the slug as written', () => {
    const index = indexEventApps([{ app: 'github', name: 'GitHub' } as ProjectTriggerEventApp]);
    expect(describeEventStatus(event('needs_connection'), testUiTranslator, index).detail).toBe(
      'Connect a shared GitHub account to activate this trigger.',
    );
  });

  test('needs_connection tells the person what to connect', () => {
    expect(describeEventStatus(event('needs_connection'), testUiTranslator).detail).toBe(
      'Connect a shared github account to activate this trigger.',
    );
  });

  test('links to the connector detail on the Connectors page', () => {
    expect(connectorHref('p1', 'github')).toBe('/projects/p1/customize/connectors?c=github');
    expect(connectorHref('p1')).toBe('/projects/p1/customize/connectors');
  });
});

describe('schemaFields example', () => {
  test('uses the first schema example as the placeholder', () => {
    const [field] = schemaFields({
      properties: { repo: { type: 'string', examples: ['acme/api', 'acme/web'] } },
    });
    expect(field.example).toBe('acme/api');
    expect(schemaFields(configSchema)[0].example).toBeNull();
  });
});

describe('parseConfigErrors', () => {
  const fields = schemaFields(configSchema);

  test('puts each problem under its own field and drops the description', () => {
    const out = parseConfigErrors(
      'Invalid config for GITHUB_X: repo is required (owner/name); limit must be integer (How many).',
      fields,
    );
    expect(out.byField).toEqual({
      repo: 'Repo is required.',
      limit: 'Limit must be integer.',
    });
    expect(out.general).toBeNull();
  });

  test('keeps a message that is not a config error as a general error', () => {
    expect(parseConfigErrors('Unknown event X for github.', fields)).toEqual({
      byField: {},
      general: 'Unknown event X for github.',
    });
  });

  test('a description containing a semicolon does not leak into general', () => {
    const out = parseConfigErrors('Invalid config for E: repo is required (a; b).', fields);
    expect(out.byField.repo).toBe('Repo is required.');
    expect(out.general).toBeNull();
  });
});

describe('groupEventApps', () => {
  const app = (name: string, connector: string | null, connected = false) => ({
    provider: 'composio',
    app: name.toLowerCase(),
    name,
    logo: null,
    event_count: 3,
    connector,
    connected,
  });
  const apps = [
    app('Notion', null),
    app('Gmail', 'gmail', false),
    app('Github', 'github', true),
    app('Linear', null),
  ];

  test('your apps first, connected before unconnected, then the rest by name', () => {
    const { yours, more } = groupEventApps(apps, '');
    expect(yours.map((a) => a.name)).toEqual(['Github', 'Gmail']);
    expect(more.map((a) => a.name)).toEqual(['Linear', 'Notion']);
  });

  test('popular apps lead the catalog', () => {
    const { more } = groupEventApps(
      [app('Asana', null), app('Github', null), app('Gmail', null)],
      '',
    );
    expect(more.map((a) => a.name)).toEqual(['Gmail', 'Github', 'Asana']);
  });

  test('searches name and app slug in both groups', () => {
    const { yours, more } = groupEventApps(apps, ' li ');
    expect(yours).toEqual([]);
    expect(more.map((a) => a.name)).toEqual(['Linear']);
  });
});

describe('newConnectorSlug', () => {
  test('uses the app slug, then numbers it when taken', () => {
    expect(newConnectorSlug('linear', [])).toBe('linear');
    expect(newConnectorSlug('linear', ['linear'])).toBe('linear-2');
    expect(newConnectorSlug('googlecalendar', ['googlecalendar', 'googlecalendar-2'])).toBe(
      'googlecalendar-3',
    );
  });
});

const profile: ProjectTriggerEventConnector = {
  slug: 'github-work',
  name: 'GitHub work',
  accounts: [
    { label: 'Project connection', connected_as: 'acme-org', is_default: true, connected: true },
    { label: 'acme-bot', connected_as: null, is_default: false, connected: true },
  ],
};

function eventOf(patch: Partial<ProjectTriggerEvent>): ProjectTriggerEvent {
  return {
    connector: 'github',
    app: 'github',
    type: 'GITHUB_PULL_REQUEST_EVENT',
    config: {},
    status: 'active',
    error: null,
    last_event_at: null,
    ...patch,
  } as ProjectTriggerEvent;
}

const githubIndex = indexEventApps([{ app: 'github', name: 'GitHub' } as ProjectTriggerEventApp]);

describe('describeEventSource', () => {
  test('names the app alone when the connector is the app and the default account feeds it', () => {
    expect(describeEventSource(eventOf({}), testUiTranslator)).toBe('github');
    expect(describeEventSource(eventOf({}), testUiTranslator, githubIndex)).toBe('GitHub');
  });
  test('ends with the event source adapter by display name; an unmapped id is capitalized', () => {
    expect(describeEventSource(eventOf({ source: 'composio' }), testUiTranslator, githubIndex)).toBe('GitHub · via Composio');
    expect(describeEventSource(eventOf({ provider: 'composio' }), testUiTranslator, githubIndex)).toBe('GitHub · via Composio');
    expect(describeEventSource(eventOf({ source: 'acme_hooks' }), testUiTranslator, githubIndex)).toBe('GitHub · via Acme hooks');
    expect(eventSourceName(eventOf({ source: 'composio' }))).toBe('Composio');
    expect(eventSourceName(eventOf({}))).toBeNull();
  });
  test('adds the connector when it is a different profile, and the account it runs as', () => {
    expect(
      describeEventSource(eventOf({ connector: 'github-work', account: 'acme-bot', source: 'composio' }), testUiTranslator, githubIndex),
    ).toBe('GitHub · github-work · acme-bot · via Composio');
    expect(
      describeEventSource(eventOf({ connector: 'github-work', connected_as: 'acme-org' }), testUiTranslator, githubIndex),
    ).toBe('GitHub · github-work · acme-org');
  });
});

describe('event titles and app names', () => {
  const gmail = { app: 'gmail', name: 'Gmail' } as ProjectTriggerEventApp;
  const index = indexEventApps([gmail]);

  test('an app name comes from the catalog; without it the slug stays as written', () => {
    expect(eventAppName(eventOf({ app: 'gmail', connector: 'gmail' }), index)).toBe('Gmail');
    expect(eventAppName(eventOf({ app: 'docs-mcp', connector: 'docs-mcp' }), index)).toBe('docs-mcp');
    expect(eventAppName(eventOf({ app: null, connector: 'github-work' }))).toBe('github-work');
  });

  test('the adapter name wins when the catalog has it', () => {
    const names = new Map([['GMAIL_NEW_GMAIL_MESSAGE', 'New Gmail Message']]);
    expect(describeEventTitle(eventOf({ app: 'gmail', type: 'GMAIL_NEW_GMAIL_MESSAGE' }), names)).toBe(
      'New Gmail Message',
    );
  });

  test('without the catalog the id loses its app prefix and noise suffix, in title case', () => {
    expect(describeEventTitle(eventOf({ type: 'GITHUB_PULL_REQUEST_CREATED' }))).toBe('Pull Request Created');
    expect(describeEventTitle(eventOf({ type: 'GITHUB_COMMIT_EVENT' }))).toBe('Commit');
    expect(describeEventTitle(eventOf({ type: 'GITHUB_BRANCH_CREATED_TRIGGER' }))).toBe('Branch Created');
  });

  test('never repeats the app: "<event> on <App>" is gone, and the app name inside the event is kept right', () => {
    const title = describeEventTitle(
      eventOf({ app: 'gmail', connector: 'gmail', type: 'GMAIL_NEW_GMAIL_MESSAGE' }),
      undefined,
      'Gmail',
    );
    expect(title).toBe('New Gmail Message');
    expect(title).not.toMatch(/ on /);
  });
});

describe('accounts of a connector', () => {
  test('the default account is selected when a trigger names none', () => {
    expect(selectedAccountLabel(profile, null)).toBe('Project connection');
    expect(selectedAccountLabel(profile, 'acme-bot')).toBe('acme-bot');
  });
  test('with no default flagged, the first connected account is selected, else the first', () => {
    const none: ProjectTriggerEventConnector = {
      ...profile,
      accounts: [
        { label: 'a-pending', connected_as: null, is_default: false, connected: false },
        { label: 'b-live', connected_as: null, is_default: false, connected: true },
      ],
    };
    expect(fallbackAccount(none)?.label).toBe('b-live');
    expect(selectedAccountLabel(none, null)).toBe('b-live');
    const allPending = { ...none, accounts: [none.accounts[0]] };
    expect(selectedAccountLabel(allPending, null)).toBe('a-pending');
    expect(selectedAccountLabel({ ...none, accounts: [] }, null)).toBeNull();
  });
  test('a new trigger names the account it will use only when the connector has no default', () => {
    const none: ProjectTriggerEventConnector = {
      ...profile,
      accounts: [{ label: 'b-live', connected_as: null, is_default: false, connected: true }],
    };
    expect(accountToWrite(none, null)).toBe('b-live');
    expect(accountToWrite(profile, null)).toBeNull();
    expect(accountToWrite(profile, 'acme-bot')).toBe('acme-bot');
    expect(accountToWrite(null, null)).toBeNull();
  });
  test('only a non-default account is stored', () => {
    expect(accountToStore(profile, 'Project connection')).toBeNull();
    expect(accountToStore(profile, 'acme-bot')).toBe('acme-bot');
    expect(accountToStore(profile, null)).toBeNull();
  });
  test('an account row leads with the identity and keeps the label as detail', () => {
    expect(describeAccount(profile.accounts[0])).toEqual({
      title: 'acme-org',
      detail: 'Project connection',
    });
    expect(describeAccount(profile.accounts[1])).toEqual({ title: 'acme-bot', detail: null });
  });
});

describe('connectors of an app', () => {
  const base = {
    provider: 'composio',
    app: 'github',
    name: 'GitHub',
    logo: null,
    event_count: 3,
    connector: 'github-work',
    connected: true,
  } as ProjectTriggerEventApp;

  test('uses the listed profiles, else the one connector the API names', () => {
    expect(appConnectors({ ...base, connectors: [profile] })).toEqual([profile]);
    expect(appConnectors(base)).toEqual([{ slug: 'github-work', name: 'GitHub', accounts: [] }]);
    expect(appConnectors({ ...base, connector: null })).toEqual([]);
  });
  test('a profile is connected when one of its accounts is; without account data the app decides', () => {
    expect(profileConnected({ ...base, connectors: [profile] }, 'github-work')).toBe(true);
    expect(
      profileConnected(
        {
          ...base,
          connectors: [
            {
              ...profile,
              accounts: [{ ...profile.accounts[0], connected: false }],
            },
          ],
        },
        'github-work',
      ),
    ).toBe(false);
    expect(profileConnected(base, 'github-work')).toBe(true);
    expect(profileConnected(base, 'other')).toBe(false);
  });
  test('lists the event triggers of one connector only', () => {
    const t = (slug: string, type: string, connector: string) =>
      ({ slug, type, event: type === 'event' ? eventOf({ connector }) : null }) as ProjectTrigger;
    const list = [t('a', 'event', 'github'), t('b', 'event', 'github-work'), t('c', 'cron', 'github')];
    expect(eventTriggersOn(list, 'github').map((x) => x.slug)).toEqual(['a']);
  });
});
