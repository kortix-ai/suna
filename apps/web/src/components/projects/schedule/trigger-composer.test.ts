import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { testUiTranslator as t } from '@/i18n/test-translator';
import type { ProjectTriggerEventApp, ProjectTriggerEventType } from '@kortix/sdk';

import { defaultConfigDraft, oneLineDescription, schemaFields } from './event-trigger-copy';
import {
  type ComposerDraft,
  autoName,
  connectionView,
  findDraftApp,
  initialDraft,
  resolveProfile,
  runCreate,
  summarize,
  triggerConnection,
  triggerName,
  validate,
  withAppPicked,
  withEventCleared,
  withEventPicked,
  withKind,
  withProfilePicked,
} from './trigger-composer-logic';

const read = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8');

/** Comments stripped, same convention as `new-workspace-errors.test.ts`. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const composer = stripComments(read('trigger-composer.tsx'));
const logic = stripComments(read('trigger-composer-logic.ts'));

const pullRequestCreated: ProjectTriggerEventType = {
  type: 'GITHUB_PULL_REQUEST_EVENT',
  name: 'Pull request created',
  description: 'A pull request is opened.',
  delivery: 'webhook',
  config_schema: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', title: 'Repository' },
      days: { type: 'integer', title: 'Days' },
    },
  },
  payload_schema: { type: 'object', properties: { title: { type: 'string' } } },
} as unknown as ProjectTriggerEventType;

const issueOpened = {
  ...pullRequestCreated,
  type: 'GITHUB_ISSUE_EVENT',
  name: 'Issue opened',
} as ProjectTriggerEventType;

const githubApp: ProjectTriggerEventApp = {
  source: 'composio',
  provider: 'composio',
  app: 'github',
  name: 'GitHub',
  logo: null,
  event_count: 46,
  connector: 'github',
  connected: false,
  connectors: [{ slug: 'github', name: 'GitHub', accounts: [] }],
};

const gmailApp: ProjectTriggerEventApp = {
  source: 'composio',
  provider: 'composio',
  app: 'gmail',
  name: 'Gmail',
  logo: null,
  event_count: 2,
  connector: null,
  connected: false,
  new_connector_slug: 'gmail-events',
};

function draftOf(patch: Partial<ComposerDraft> = {}): ComposerDraft {
  return { ...initialDraft({}), ...patch };
}

describe('trigger composer: the summary sentence', () => {
  test('a schedule names its cadence, timezone and agent', () => {
    expect(summarize(draftOf({ agent: 'researcher' }), null, 'Researcher', t)).toBe(
      'Every day at 09:00 (UTC), Researcher runs your instruction.',
    );
  });

  test('a one-off schedule names the time instead of the cadence', () => {
    const text = summarize(draftOf({ runAt: '2030-01-02T09:30:00.000Z' }), null, 'Kortix', t);
    expect(text.startsWith('Once on ')).toBe(true);
    expect(text.endsWith(', Kortix runs your instruction.')).toBe(true);
  });

  test('an app event names the event and the app', () => {
    const draft = draftOf({ kind: 'event', appSlug: 'github', eventType: pullRequestCreated });
    expect(summarize(draft, githubApp, 'Kortix', t)).toBe(
      'When “Pull request created” happens in GitHub, Kortix runs your instruction.',
    );
  });

  test('an app event with no event yet says what a trigger is', () => {
    const draft = draftOf({ kind: 'event', appSlug: 'github' });
    expect(summarize(draft, githubApp, 'Kortix', t)).toBe('Choose how this trigger starts.');
  });

  test('a webhook says who starts it', () => {
    expect(summarize(draftOf({ kind: 'webhook' }), null, 'Kortix', t)).toBe(
      'When your app calls the webhook, Kortix runs your instruction.',
    );
  });
});

describe('trigger composer: the name follows the When block until it is edited', () => {
  test('a schedule is named by its cadence, a webhook "Webhook", an event by its title', () => {
    expect(autoName(draftOf(), t)).toBe('Every day at 09:00');
    expect(autoName(draftOf({ kind: 'webhook' }), t)).toBe('Webhook');
    expect(autoName(draftOf({ kind: 'event', eventType: pullRequestCreated }), t)).toBe(
      'Pull request created',
    );
    expect(autoName(draftOf({ kind: 'event' }), t)).toBe('');
  });

  test('the shown name changes with the When block while nothing was typed', () => {
    let draft = draftOf({ kind: 'event', appSlug: 'github' });
    expect(triggerName(draft, t)).toBe('');
    draft = withEventPicked(draft, pullRequestCreated, {});
    expect(triggerName(draft, t)).toBe('Pull request created');
    draft = withEventPicked(draft, issueOpened, {});
    expect(triggerName(draft, t)).toBe('Issue opened');
  });

  test('a typed name stays through a cadence change, a kind switch and an event change', () => {
    let draft = draftOf({ nameOverride: 'Morning digest' });
    draft = { ...draft, cron: '0 30 8 * * *' };
    expect(triggerName(draft, t)).toBe('Morning digest');
    draft = withKind(draft, 'webhook');
    expect(triggerName(draft, t)).toBe('Morning digest');
    draft = withEventPicked(withKind(draft, 'event'), issueOpened, {});
    expect(triggerName(draft, t)).toBe('Morning digest');
  });
});

describe('trigger composer: switching the kind keeps the Then block', () => {
  test('instruction, agent and model survive every switch', () => {
    const typed = draftOf({ instruction: 'Summarise the inbox', agent: 'researcher' });
    for (const kind of ['event', 'webhook', 'cron'] as const) {
      const next = withKind(typed, kind);
      expect(next.kind).toBe(kind);
      expect(next.instruction).toBe('Summarise the inbox');
      expect(next.agent).toBe('researcher');
    }
  });

  test('each kind keeps its own When settings while another is shown', () => {
    const typed = draftOf({ cron: '0 0 7 * * *', signingKey: 'abc' });
    const there = withKind(withKind(typed, 'webhook'), 'cron');
    expect(there.cron).toBe('0 0 7 * * *');
    expect(there.signingKey).toBe('abc');
  });
});

describe('trigger composer: picking an event', () => {
  test('the prefilled instruction follows the event, the typed one does not', () => {
    let draft = withEventPicked(draftOf({ kind: 'event' }), pullRequestCreated, {});
    expect(draft.instruction).toContain('Pull request created just happened');
    draft = withEventPicked(draft, issueOpened, {});
    expect(draft.instruction).toContain('Issue opened just happened');
    draft = withEventPicked({ ...draft, instruction: 'Triage it' }, pullRequestCreated, {});
    expect(draft.instruction).toBe('Triage it');
  });

  test('Change on the chosen event clears its prefill and its config, not typed words', () => {
    const picked = withEventPicked(draftOf({ kind: 'event' }), pullRequestCreated, { repo: 'a/b' });
    const cleared = withEventCleared(picked);
    expect(cleared.eventType).toBeNull();
    expect(cleared.instruction).toBe('');
    expect(cleared.configDraft).toEqual({});
    const typed = withEventCleared({ ...picked, instruction: 'Triage it' });
    expect(typed.instruction).toBe('Triage it');
  });

  test('Change app drops the event, the connector and the account, and keeps the Then block', () => {
    const picked = {
      ...withEventPicked(draftOf({ kind: 'event', appSlug: 'github' }), pullRequestCreated, {}),
      profile: 'github',
      account: 'bot',
      instruction: 'Triage it',
    };
    const next = withAppPicked(picked, 'gmail');
    expect(next).toMatchObject({
      appSlug: 'gmail',
      profile: null,
      account: null,
      eventType: null,
      instruction: 'Triage it',
    });
  });
});

describe('trigger composer: the app and its connector', () => {
  const apps = [githubApp, gmailApp];

  test('the draft finds its app by slug, or by the connector it was opened on', () => {
    expect(findDraftApp(apps, draftOf({ appSlug: 'gmail' }))).toBe(gmailApp);
    expect(findDraftApp(apps, draftOf({ profile: 'github' }))).toBe(githubApp);
    expect(findDraftApp(apps, draftOf())).toBeNull();
  });

  test('an app the project has runs on its first connector; one it lacks has none', () => {
    expect(resolveProfile(githubApp, draftOf())).toBe('github');
    expect(resolveProfile(gmailApp, draftOf())).toBeNull();
  });
});

describe('trigger composer: Create writes in order', () => {
  test('an app with no connector gets its connector first, then the trigger', async () => {
    const calls: string[] = [];
    const created = await runCreate({
      addConnector: async () => {
        calls.push('POST /connectors');
        return 'gmail-events';
      },
      createTrigger: async (connector) => {
        calls.push(`POST /triggers on ${connector}`);
        return 'ok';
      },
    });
    expect(created).toBe('ok');
    expect(calls).toEqual(['POST /connectors', 'POST /triggers on gmail-events']);
  });

  test('a failed connector write creates no trigger and reaches the caller', async () => {
    const calls: string[] = [];
    await expect(
      runCreate({
        addConnector: async () => {
          calls.push('POST /connectors');
          throw new Error('Connector slug is reserved');
        },
        createTrigger: async () => {
          calls.push('POST /triggers');
          return 'ok';
        },
      }),
    ).rejects.toThrow('Connector slug is reserved');
    expect(calls).toEqual(['POST /connectors']);
  });

  test('an app the project already has writes the trigger alone', async () => {
    const calls: string[] = [];
    await runCreate({
      addConnector: null,
      createTrigger: async (connector) => {
        calls.push(`POST /triggers on ${connector}`);
      },
    });
    expect(calls).toEqual(['POST /triggers on null']);
  });

  test('browsing sends nothing: the composer adds a connector in one place, inside Create', () => {
    expect(composer.match(/\badd\(/g)?.length).toBe(1);
    expect(composer.indexOf('add({')).toBeGreaterThan(composer.indexOf('runCreate({'));
  });
});

describe('trigger composer: inline validation', () => {
  const fields = schemaFields(pullRequestCreated.config_schema);
  const ctx = (name = 'A name', app: ProjectTriggerEventApp | null = githubApp) => ({
    name,
    configFields: fields,
    app,
  });
  const blocks = (draft: ComposerDraft, name?: string) =>
    validate(draft, ctx(name), t).map((p) => p.block);

  test('a fresh schedule needs only its instruction', () => {
    expect(validate(draftOf(), ctx(), t).map((p) => p.message)).toEqual([
      'Say what the agent should do.',
    ]);
  });

  test('problems come in the order the blocks appear', () => {
    const draft = draftOf({ kind: 'webhook', mode: 'keyed' });
    expect(blocks(draft, '')).toEqual(['when', 'then', 'name', 'options']);
  });

  test('an app event with no app, then no event, says which', () => {
    const noApp = validate(draftOf({ kind: 'event', instruction: 'x' }), ctx('A name', null), t);
    expect(noApp.map((p) => p.message)).toEqual(['Pick the app the event happens in.']);
    const noEvent = validate(
      draftOf({ kind: 'event', appSlug: 'github', instruction: 'x' }),
      ctx(),
      t,
    );
    expect(noEvent.map((p) => p.message)).toEqual(['Pick the event that starts the agent.']);
  });

  test('a missing required event setting lands under its own field', () => {
    const draft = withEventPicked(
      draftOf({ kind: 'event', appSlug: 'github' }),
      pullRequestCreated,
      defaultConfigDraft(fields),
    );
    const problems = validate({ ...draft, instruction: 'x' }, ctx(), t);
    expect(problems).toEqual([
      { block: 'when', field: 'repo', message: 'Repository is required.' },
    ]);
    const filled = {
      ...draft,
      instruction: 'x',
      configDraft: { ...draft.configDraft, repo: 'a/b' },
    };
    expect(validate(filled, ctx(), t)).toEqual([]);
  });

  test('a one-off in the past or a webhook with no key is refused at the When block', () => {
    const past = validate(
      draftOf({ runAt: '2020-01-01T00:00:00.000Z', instruction: 'x' }),
      ctx(),
      t,
    );
    expect(past.map((p) => p.message)).toEqual(['Pick a time in the future.']);
    const noKey = validate(draftOf({ kind: 'webhook', instruction: 'x' }), ctx(), t);
    expect(noKey.map((p) => p.message)).toEqual([
      'Add a signing key so only your app can start this.',
    ]);
  });

  test('a half-filled condition is an Options problem, and a schedule has no conditions', () => {
    const half = draftOf({
      kind: 'webhook',
      signingKey: 'k',
      instruction: 'x',
      conditions: [{ path: 'a', value: '' }],
    });
    expect(validate(half, ctx(), t).map((p) => p.block)).toEqual(['options']);
    expect(validate({ ...half, kind: 'cron' }, ctx(), t)).toEqual([]);
  });
});

describe('trigger composer: the webhook signing secret is delivered as broker', () => {
  // Trigger validation (apps/api/src/projects/lib/webhook-secret-policy.ts)
  // accepts a secret_env only when it is delivered as broker to the connector
  // consumer, so the composer must never create it without that policy.
  test('the signing key is upserted with broker/connector delivery', () => {
    expect(composer).toContain(`strategy: 'broker'`);
    expect(composer).toContain(`consumer: 'connector'`);
  });

  test('the upsert targets the same project as the trigger being created', () => {
    expect(composer).toContain('upsertProjectSecret(projectId');
  });

  test('no runtime-delivery signing key remains', () => {
    expect(composer).not.toMatch(/strategy:\s*'runtime'/);
  });
});

describe('trigger composer: the signing key is cryptographically random', () => {
  // CodeQL js/insecure-randomness (alert #6471). `generateSigningKey` fell back
  // to `Math.random().toString(36)` when `crypto.getRandomValues` was missing.
  // That key SIGNS webhook payloads, so a predictable one is forgeable.
  const generator = logic.slice(
    logic.indexOf('function generateSigningKey'),
    logic.indexOf('function normalizeSecretName'),
  );

  test('the generator never falls back to Math.random', () => {
    expect(generator.length).toBeGreaterThan(0);
    expect(generator).not.toContain('Math.random');
  });

  test('it uses crypto.getRandomValues over 32 bytes', () => {
    expect(generator).toContain('crypto.getRandomValues');
    expect(generator).toContain('Uint8Array(32)');
  });

  test('an environment without a CSPRNG is refused, not silently downgraded', () => {
    expect(generator).toContain('throw new Error');
  });
});

describe('trigger composer: event descriptions read as one line', () => {
  test('list bullets, emphasis and line breaks are dropped', () => {
    expect(
      oneLineDescription(
        'Monitors a specific branch for:\n- New commits pushed (head SHA changes)\n* Protection toggled\n  **Bold** and `code`.',
      ),
    ).toBe(
      'Monitors a specific branch for: New commits pushed (head SHA changes) Protection toggled Bold and code.',
    );
  });

  test('a hyphen inside a sentence stays', () => {
    expect(oneLineDescription('A well-known  event - fires once.')).toBe(
      'A well-known event - fires once.',
    );
  });
});

describe('trigger composer: the summary names the agent as the picker does', () => {
  test('both use agentDisplayLabel: a picked name is capitalised, nothing picked is the first agent', async () => {
    const { agentDisplayLabel } = await import('@/features/session/composer/agent-selector');
    const agents = [{ name: 'researcher' }, { name: 'writer' }] as Parameters<
      typeof agentDisplayLabel
    >[0];
    expect(agentDisplayLabel(agents, 'writer')).toBe('Writer');
    expect(agentDisplayLabel(agents, null)).toBe('Researcher');
    expect(agentDisplayLabel([], null)).toBe('Agent');
    expect(read('trigger-composer.tsx')).toContain('agentDisplayLabel(agents, draft.agent)');
  });
});

describe('trigger composer: connector first, then its account', () => {
  const account = (label: string, extra: object = {}) => ({
    label,
    connected_as: null,
    is_default: false,
    connected: true,
    ...extra,
  });
  const work = {
    slug: 'github-work',
    name: 'GitHub (work)',
    accounts: [account('acme-bot', { is_default: true }), account('acme-ci')],
  };
  const side = {
    slug: 'github-side',
    name: 'GitHub (side)',
    accounts: [account('solo', { is_default: true })],
  };
  const empty = { slug: 'github-new', name: 'GitHub (new)', accounts: [] };
  const app = { ...githubApp, connector: 'github-work', connectors: [work, side, empty] };
  const base = draftOf({ kind: 'event', appSlug: 'github' });

  test('the entry point chooses the connector, else the first one', () => {
    expect(connectionView(app, base).profile?.slug).toBe('github-work');
    expect(connectionView(app, draftOf({ profile: 'github-side' })).profile?.slug).toBe(
      'github-side',
    );
  });

  test('the default account is selected when none is chosen', () => {
    expect(connectionView(app, base).selectedAccount).toBe('acme-bot');
    expect(connectionView(app, { ...base, account: 'acme-ci' }).selectedAccount).toBe('acme-ci');
  });

  test('picking another connector swaps the account list and resets to its default', () => {
    const picked = withProfilePicked({ ...base, account: 'acme-ci' }, 'github-side');
    const view = connectionView(app, picked);
    expect(view.profile?.accounts.map((a) => a.label)).toEqual(['solo']);
    expect(view.selectedAccount).toBe('solo');
    expect(picked.account).toBeNull();
  });

  test('a connector with no account shows no list, only the connect prompt', () => {
    const view = connectionView(app, withProfilePicked(base, 'github-new'));
    expect(view).toMatchObject({ noAccounts: true, selectedAccount: null });
    expect(connectionView(app, base).noAccounts).toBe(false);
  });

  test('the payload names the connector, and an account only when it is not the default', () => {
    expect(triggerConnection(app, base, null)).toEqual({ connector: 'github-work' });
    expect(triggerConnection(app, { ...base, account: 'acme-ci' }, null)).toEqual({
      connector: 'github-work',
      event_account: 'acme-ci',
    });
    expect(triggerConnection(app, withProfilePicked(base, 'github-side'), null)).toEqual({
      connector: 'github-side',
    });
    expect(triggerConnection(gmailApp, base, 'gmail-events')).toEqual({
      connector: 'gmail-events',
    });
  });
});

describe('triggers page: the paused banner keeps a space before the button name', () => {
  test("`text3bc554b5c290` ends mid-sentence, so the page joins it to the label with {' '}", () => {
    const view = readFileSync(join(import.meta.dir, '..', 'schedule-view.tsx'), 'utf8');
    expect(view).toMatch(/text3bc554b5c290'\)\}\{' '\}\s*\{copy\.createLabel\}/);
  });
});
