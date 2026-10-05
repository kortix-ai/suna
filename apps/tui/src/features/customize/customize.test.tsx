import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { type AgentRowData, AgentsTabView, agentRows } from './agents-tab.tsx';
import {
  type ConnectorRowData,
  ConnectorsTabView,
  connectorRows,
  connectorSetup,
  connectorWebUrl,
} from './connectors-tab.tsx';
import { CustomizeShell } from './customize-screen.tsx';
import { wrapText } from './fields.tsx';
import { CUSTOMIZE_TABS } from './keys.ts';
import { type SecretRowData, SecretsTabView, secretRows } from './secrets-tab.tsx';
import { SkillsTabView, skillRows, skillScope } from './skills-tab.tsx';
import {
  type TriggerRowData,
  TriggersTabView,
  describeWhen,
  triggerRows,
} from './triggers-tab.tsx';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const SIZE = { width: 90, height: 24 };

/** A lone ESC is the prefix of every escape sequence; the parser holds it. */
async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

// ───────────────────────────── pure row builders ────────────────────────────

describe('agentRows', () => {
  const config = {
    agents: [
      {
        name: 'default',
        path: '.opencode/agent/default.md',
        description: 'The everyday agent',
        mode: 'primary',
        model: 'openai/gpt-5.6-sol',
      },
      {
        name: 'auditor',
        path: 'kortix.yaml#agents.auditor',
        description: null,
        mode: 'primary',
        enabled: false,
      },
    ],
    default_agent: 'auditor',
    open_code_default_agent: 'default',
  };

  test('marks the provider-neutral default, not the deprecated one', () => {
    const rows = agentRows(config);
    expect(rows.map((row) => [row.name, row.isDefault])).toEqual([
      ['default', false],
      ['auditor', true],
    ]);
  });

  test('falls back to the deprecated default when the new field is absent', () => {
    const rows = agentRows({ ...config, default_agent: null });
    expect(rows.find((row) => row.name === 'default')?.isDefault).toBe(true);
  });

  test('an agent with no `enabled` field is enabled', () => {
    const rows = agentRows(config);
    expect(rows.map((row) => row.enabled)).toEqual([true, false]);
  });
});

describe('skillScope / skillRows', () => {
  test('a path under .kortix is a platform skill, anything else the project’s', () => {
    expect(skillScope('/workspace/.kortix/skills/pdf/SKILL.md')).toBe('kortix');
    expect(skillScope('.opencode/skill/deal-desk/SKILL.md')).toBe('project');
  });

  test('skillRows carries the path as the row id source', () => {
    const rows = skillRows({
      skills: [{ name: 'pdf', path: '.kortix/skills/pdf/SKILL.md', description: 'Read PDFs' }],
    });
    expect(rows[0]).toMatchObject({ name: 'pdf', scope: 'kortix', description: 'Read PDFs' });
  });
});

describe('secretRows', () => {
  const stored = {
    identifier: 'STRIPE_API_KEY',
    name: 'STRIPE_API_KEY',
    project_id: 'p',
    secret_id: 's1',
    created_by: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-17T10:00:00.000Z',
    configured: true,
    mine: null,
    effective_source: 'shared' as const,
    can_manage_shared: true,
  };

  test('a configured row reads Set and a system row reads Managed by Kortix', () => {
    const rows = secretRows({
      items: [
        stored,
        { ...stored, identifier: 'KORTIX_TOKEN', name: 'KORTIX_TOKEN', system: true },
      ],
    });
    expect(rows.map((row) => row.status)).toEqual(['Set', 'Managed by Kortix']);
  });

  test('a manifest key nothing has filled becomes a Not set row that cannot be deleted', () => {
    const rows = secretRows({ items: [stored], required: ['STRIPE_API_KEY', 'SLACK_TOKEN'] });
    const slack = rows.find((row) => row.identifier === 'SLACK_TOKEN');
    expect(slack).toMatchObject({ status: 'Not set', deletable: false, required: true });
    // The key already covered by a stored row is not repeated.
    expect(rows.filter((row) => row.identifier === 'STRIPE_API_KEY')).toHaveLength(1);
  });

  test('a system row is never deletable', () => {
    const rows = secretRows({ items: [{ ...stored, system: true }] });
    expect(rows[0]?.deletable).toBe(false);
  });
});

describe('describeWhen / triggerRows', () => {
  const base = {
    slug: 'nightly',
    path: 'kortix.yaml#triggers.nightly',
    name: 'Nightly digest',
    agent: 'default',
    model: null,
    enabled: true,
    cron: '0 0 9 * * 1-5',
    run_at: null,
    timezone: 'Europe/Zurich',
    secret_env: null,
    run: null,
    mode: null,
    interval_seconds: null,
    expect_event_within_seconds: null,
    prompt_template: 'Summarize yesterday.',
    session_mode: 'fresh' as const,
    session_id: null,
    session_key: null,
    filter: null,
    session_access: { mode: 'private' as const, memberIds: [], groupIds: [] },
    last_fired_at: null,
    webhook_url: null,
  };

  test('a cron trigger prints its expression and timezone', () => {
    expect(describeWhen({ ...base, type: 'cron' })).toBe('0 0 9 * * 1-5 (Europe/Zurich)');
  });

  test('a webhook trigger prints the web’s own sentence', () => {
    expect(describeWhen({ ...base, type: 'webhook', cron: null })).toBe('When a request arrives');
  });

  test('a one-off cron prints its instant, and a poll monitor its interval', () => {
    expect(
      describeWhen({ ...base, type: 'cron', cron: null, run_at: '2026-10-01T09:00:00Z' }),
    ).toBe('Once at 2026-10-01T09:00:00Z');
    expect(
      describeWhen({ ...base, type: 'monitor', cron: null, mode: 'poll', interval_seconds: 30 }),
    ).toBe('Monitor · every 30s');
  });

  test('triggerRows carries the slug the update call needs', () => {
    expect(triggerRows([{ ...base, type: 'cron' }])[0]).toMatchObject({
      slug: 'nightly',
      enabled: true,
      agent: 'default',
    });
  });
});

describe('connectorSetup / connectorWebUrl', () => {
  const base = {
    slug: 'slack',
    name: 'Slack',
    provider: 'composio' as const,
    status: 'active' as const,
    credentialMode: 'shared' as const,
    authorizationStrategy: 'project' as const,
    sensitive: false,
    actions: [],
    authSecret: 'SLACK_TOKEN',
    secretSet: true,
  };

  test('decides in the web’s order: error, needs_auth, no auth, user-managed, secret', () => {
    expect(connectorSetup(base)).toBe('Connected');
    expect(connectorSetup({ ...base, status: 'error' })).toBe('Error');
    expect(connectorSetup({ ...base, status: 'needs_auth' })).toBe('Needs setup');
    expect(connectorSetup({ ...base, authSecret: null })).toBe('No auth needed');
    expect(connectorSetup({ ...base, authorizationStrategy: 'user' })).toBe('User-managed');
    expect(connectorSetup({ ...base, secretSet: false })).toBe('Needs setup');
  });

  test('a connector that declares no auth reads connected even with no credential', () => {
    expect(connectorSetup({ ...base, authSecret: null, secretSet: false })).toBe('No auth needed');
  });

  test('connectorRows counts the connections behind each connector', () => {
    const rows = connectorRows(
      [base],
      [
        {
          connection_id: 'c1',
          connector_alias: 'slack',
          owner_type: 'project',
          owner_id: null,
          label: 'Sales',
          status: 'active',
          is_default: true,
          metadata: {},
        },
        {
          connection_id: 'c2',
          connector_alias: 'slack',
          owner_type: 'member',
          owner_id: 'u1',
          label: 'Mine',
          status: 'revoked',
          is_default: false,
          metadata: {},
        },
        {
          connection_id: 'c3',
          connector_alias: 'gmail',
          owner_type: 'project',
          owner_id: null,
          label: 'x',
          status: 'active',
          is_default: true,
          metadata: {},
        },
      ],
    );
    expect(rows[0]).toMatchObject({ connections: 2, brokenConnections: 1 });
  });

  test('the connect hint is the web page that runs the OAuth round-trip', () => {
    expect(connectorWebUrl('p1', 'slack', 'https://dev.kortix.com/')).toBe(
      'https://dev.kortix.com/projects/p1/connectors?c=slack',
    );
    expect(connectorWebUrl('p1', 'slack')).toBe('/projects/p1/connectors?c=slack');
  });
});

describe('wrapText', () => {
  test('wraps on word boundaries and stops at the line budget', () => {
    expect(wrapText('one two three four five', 9, 2)).toEqual(['one two', 'three']);
  });

  test('a word longer than the width is truncated, not dropped', () => {
    expect(wrapText('short supercalifragilistic', 10, 2)).toEqual(['short', 'supercali…']);
  });
});

// ───────────────────────────── the tab strip ────────────────────────────────

function Body({ label }: { label: string }) {
  return <text>{`body:${label}`}</text>;
}

describe('<CustomizeShell/>', () => {
  test('renders every tab with its digit and highlights the active one', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <CustomizeShell
        tabs={CUSTOMIZE_TABS}
        activeId="agents"
        onActivate={() => {}}
        focused
        width={88}
        height={20}
        inputActive={false}
        onBack={() => {}}
      >
        <Body label="agents" />
      </CustomizeShell>,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('1 Agents');
    expect(frame).toContain('3 Secrets');
    expect(frame).toContain('5 Connectors');
    expect(frame).toContain('body:agents');
    renderer.destroy();
  });

  test('a digit selects that tab and [ ] step through them', async () => {
    const picked: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <CustomizeShell
        tabs={CUSTOMIZE_TABS}
        activeId="agents"
        onActivate={(id) => picked.push(id)}
        focused
        width={88}
        height={20}
        inputActive={false}
        onBack={() => {}}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('4'));
    await flush();
    await act(async () => mockInput.pressKey(']'));
    await flush();
    await act(async () => mockInput.pressKey('['));
    await flush();
    // `activeId` stays `agents` (the parent owns it), so ] is Skills and [ is
    // Connectors — the wrap-around case, which is the one worth proving.
    expect(picked).toEqual(['triggers', 'skills', 'connectors']);
    renderer.destroy();
  });

  test('a digit outside the tab range selects nothing', async () => {
    const picked: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <CustomizeShell
        tabs={CUSTOMIZE_TABS}
        activeId="agents"
        onActivate={(id) => picked.push(id)}
        focused
        width={88}
        height={20}
        inputActive={false}
        onBack={() => {}}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('9'));
    await flush();
    expect(picked).toEqual([]);
    renderer.destroy();
  });

  test('Esc leaves the screen, but not while a tab owns the keys', async () => {
    let back = 0;
    const picked: string[] = [];
    const deaf = await testRender(
      <CustomizeShell
        tabs={CUSTOMIZE_TABS}
        activeId="secrets"
        onActivate={(id) => picked.push(id)}
        focused
        width={88}
        height={20}
        inputActive
        onBack={() => {
          back += 1;
        }}
      />,
      SIZE,
    );
    await deaf.flush();
    await pressEscape(deaf.mockInput);
    await deaf.flush();
    // A `1` typed into a secret name must not switch tabs either.
    await act(async () => deaf.mockInput.pressKey('1'));
    await deaf.flush();
    expect([back, picked.length]).toEqual([0, 0]);
    deaf.renderer.destroy();

    const open = await testRender(
      <CustomizeShell
        tabs={CUSTOMIZE_TABS}
        activeId="secrets"
        onActivate={() => {}}
        focused
        width={88}
        height={20}
        inputActive={false}
        onBack={() => {
          back += 1;
        }}
      />,
      SIZE,
    );
    await open.flush();
    await pressEscape(open.mockInput);
    await open.flush();
    expect(back).toBe(1);
    open.renderer.destroy();
  });
});

// ───────────────────────────── the tab bodies ───────────────────────────────

describe('<AgentsTabView/>', () => {
  const rows: AgentRowData[] = [
    {
      name: 'default',
      description: 'The everyday agent',
      model: 'openai/gpt-5.6-sol',
      mode: 'primary',
      path: '.opencode/agent/default.md',
      enabled: true,
      isDefault: true,
      scope: null,
    },
    {
      name: 'auditor',
      description: null,
      model: null,
      mode: 'primary',
      path: 'kortix.yaml#agents.auditor',
      enabled: false,
      isDefault: false,
      scope: { env: 'all', connectors: [], kortix_permissions: ['run'] },
    },
  ];

  test('lists agents with the default star, the model and the Disabled mark', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <AgentsTabView
        rows={rows}
        focused
        width={88}
        height={16}
        loading={false}
        errorMessage={null}
        onInputActive={() => {}}
      />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('★ default · The everyday agent');
    expect(frame).toContain('openai/gpt-5.6-sol');
    expect(frame).toContain('Disabled');
    renderer.destroy();
  });

  test('Enter opens the details and reports that it owns the keys; Esc closes', async () => {
    const captured: boolean[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AgentsTabView
        rows={rows}
        focused
        width={88}
        height={16}
        loading={false}
        errorMessage={null}
        onInputActive={(active) => captured.push(active)}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('kortix.yaml#agents.auditor');
    expect(frame).toContain('Uses the project default');
    expect(frame).toContain('none');
    expect(captured.at(-1)).toBe(true);

    await pressEscape(mockInput);
    await flush();
    expect(captured.at(-1)).toBe(false);
    expect(captureCharFrame()).toContain('★ default');
    renderer.destroy();
  });
});

describe('<SkillsTabView/>', () => {
  test('lists skills with their scope and opens the path on Enter', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SkillsTabView
        rows={[
          {
            name: 'deal-desk',
            path: '.opencode/skill/deal-desk/SKILL.md',
            description: 'Build a deal memo',
            scope: 'project',
          },
        ]}
        focused
        width={88}
        height={16}
        loading={false}
        errorMessage={null}
        onInputActive={() => {}}
      />,
      SIZE,
    );
    await flush();
    expect(captureCharFrame()).toContain('deal-desk · Build a deal memo');
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(captureCharFrame()).toContain('.opencode/skill/deal-desk/SKILL.md');
    renderer.destroy();
  });
});

describe('<SecretsTabView/>', () => {
  const rows: SecretRowData[] = [
    {
      identifier: 'STRIPE_API_KEY',
      name: 'STRIPE_API_KEY',
      status: 'Set',
      deletable: true,
      required: false,
      updatedMs: NOW - 5 * MINUTE,
    },
    {
      identifier: 'SLACK_TOKEN',
      name: 'SLACK_TOKEN',
      status: 'Not set',
      deletable: false,
      required: true,
      updatedMs: Number.NaN,
    },
  ];

  function view(overrides: Partial<Parameters<typeof SecretsTabView>[0]> = {}) {
    return (
      <SecretsTabView
        rows={rows}
        focused
        width={88}
        height={16}
        now={NOW}
        loading={false}
        errorMessage={null}
        onCreate={() => {}}
        onDelete={() => {}}
        onInputActive={() => {}}
        {...overrides}
      />
    );
  }

  test('lists names with their status and age, and never a value', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(view(), SIZE);
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('STRIPE_API_KEY');
    expect(frame).toMatch(/Set · 5m/);
    expect(frame).toContain('Not set');
    // The required-but-empty row carries the web's asterisk.
    expect(frame).toMatch(/\* SLACK_TOKEN/);
    renderer.destroy();
  });

  test('n adds a secret: name, then a masked value, then one create call', async () => {
    const created: Array<{ name: string; value: string }> = [];
    const frames: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ onCreate: (input) => created.push(input) }),
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(captureCharFrame()).toContain('New secret — name');

    await act(async () => mockInput.typeText('TUI_WAVE2_PROBE'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(captureCharFrame()).toContain('New secret — value');

    await act(async () => mockInput.typeText('s3cret-value'));
    await flush();
    frames.push(captureCharFrame());
    // The value is masked one bullet per character and never printed.
    expect(frames[0]).toContain('•'.repeat('s3cret-value'.length));
    expect(frames[0]).not.toContain('s3cret');

    await act(async () => mockInput.pressEnter());
    await flush();
    expect(created).toEqual([{ name: 'TUI_WAVE2_PROBE', value: 's3cret-value' }]);
    // Back to the list, with nothing left on screen from the flow.
    expect(captureCharFrame()).not.toContain('New secret');
    renderer.destroy();
  });

  test('Esc during the value step creates nothing', async () => {
    const created: Array<{ name: string; value: string }> = [];
    const { flush, mockInput, renderer } = await testRender(
      view({ onCreate: (input) => created.push(input) }),
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    await act(async () => mockInput.typeText('X'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    await act(async () => mockInput.typeText('abc'));
    await flush();
    await pressEscape(mockInput);
    await flush();
    expect(created).toEqual([]);
    renderer.destroy();
  });

  test('d asks before deleting and hands back the identifier', async () => {
    const deleted: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ onDelete: (id) => deleted.push(id) }),
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('Delete secret');

    await pressEscape(mockInput);
    await flush();
    expect(deleted).toEqual([]);

    await act(async () => mockInput.pressKey('d'));
    await flush();
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(deleted).toEqual(['STRIPE_API_KEY']);
    renderer.destroy();
  });

  test('a row that cannot be deleted never opens the confirm', async () => {
    const deleted: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ onDelete: (id) => deleted.push(id) }),
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).not.toContain('Delete secret');
    expect(deleted).toEqual([]);
    renderer.destroy();
  });

  test('a member who cannot manage gets neither n nor d', async () => {
    const created: Array<{ name: string; value: string }> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ canManage: false, onCreate: (input) => created.push(input) }),
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(captureCharFrame()).not.toContain('New secret');
    expect(created).toEqual([]);
    renderer.destroy();
  });
});

describe('<TriggersTabView/>', () => {
  const rows: TriggerRowData[] = [
    {
      slug: 'nightly',
      name: 'Nightly digest',
      type: 'cron',
      enabled: true,
      when: '0 0 9 * * 1-5 (Europe/Zurich)',
      agent: 'default',
      model: null,
      sessionMode: 'fresh',
      webhookUrl: null,
      secretEnv: null,
      promptTemplate: 'Summarize yesterday.',
      lastFiredMs: NOW - 2 * HOUR,
      path: 'kortix.yaml#triggers.nightly',
    },
    {
      slug: 'inbound',
      name: 'Inbound hook',
      type: 'webhook',
      enabled: false,
      when: 'When a request arrives',
      agent: 'default',
      model: null,
      sessionMode: 'keyed',
      webhookUrl: 'https://api.kortix.com/v1/hooks/abc',
      secretEnv: 'HOOK_SECRET',
      promptTemplate: 'Handle {{ body.kind }}.',
      lastFiredMs: Number.NaN,
      path: 'kortix.yaml#triggers.inbound',
    },
  ];

  function view(overrides: Partial<Parameters<typeof TriggersTabView>[0]> = {}) {
    return (
      <TriggersTabView
        rows={rows}
        focused
        width={88}
        height={16}
        now={NOW}
        loading={false}
        errorMessage={null}
        onToggle={() => {}}
        onInputActive={() => {}}
        {...overrides}
      />
    );
  }

  test('lists each trigger with Active/Paused, its schedule and its last run', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(view(), SIZE);
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Nightly digest · 0 0 9 * * 1-5 (Europe/Zurich)');
    expect(frame).toMatch(/Active · 2h ago/);
    expect(frame).toContain('Inbound hook · When a request arrives');
    expect(frame).toMatch(/Paused · Never/);
    renderer.destroy();
  });

  test('Space and t toggle the selected trigger to the opposite state', async () => {
    const toggles: Array<[string, boolean]> = [];
    const { flush, mockInput, renderer } = await testRender(
      view({ onToggle: (slug, enabled) => toggles.push([slug, enabled]) }),
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey(' '));
    await flush();
    expect(toggles).toEqual([['nightly', false]]);

    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('t'));
    await flush();
    expect(toggles).toEqual([
      ['nightly', false],
      ['inbound', true],
    ]);
    renderer.destroy();
  });

  test('Enter shows the details, including the webhook signing state', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(view(), SIZE);
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('yes (HOOK_SECRET)');
    expect(frame).toContain('https://api.kortix.com/v1/hooks/abc');
    expect(frame).toContain('keyed');
    renderer.destroy();
  });

  test('the project kill switch and a parse error each get their own line', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      view({ paused: true, parseErrors: [{ slug: 'broken', error: 'cron: bad field' }] }),
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Triggers are paused for this project');
    expect(frame).toContain('broken: cron: bad field');
    renderer.destroy();
  });
});

describe('<ConnectorsTabView/>', () => {
  const rows: ConnectorRowData[] = [
    {
      slug: 'slack',
      name: 'Slack',
      provider: 'composio',
      setup: 'Connected',
      toolCount: 42,
      sensitive: false,
      connections: 2,
      brokenConnections: 0,
    },
    {
      slug: 'gmail',
      name: 'Gmail',
      provider: 'pipedream',
      setup: 'Needs setup',
      toolCount: 17,
      sensitive: true,
      connections: 0,
      brokenConnections: 0,
    },
  ];

  test('lists connectors with their tool count and setup word', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <ConnectorsTabView
        rows={rows}
        focused
        width={88}
        height={16}
        loading={false}
        errorMessage={null}
        connectUrlFor={(slug) => `https://dev.kortix.com/projects/p1/connectors?c=${slug}`}
        onInputActive={() => {}}
      />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('✓ Slack · 42 tools · composio');
    expect(frame).toContain('Connected');
    expect(frame).toContain('○ Gmail · 17 tools · pipedream');
    expect(frame).toContain('Needs setup');
    renderer.destroy();
  });

  test('Enter shows the connect URL instead of running an OAuth flow', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ConnectorsTabView
        rows={rows}
        focused
        width={88}
        height={16}
        loading={false}
        errorMessage={null}
        connectUrlFor={(slug) => `https://dev.kortix.com/projects/p1/connectors?c=${slug}`}
        onInputActive={() => {}}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('https://dev.kortix.com/projects/p1/connectors?c=gmail');
    expect(frame).toContain('none');
    renderer.destroy();
  });
});
