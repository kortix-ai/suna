import { describe, expect, test } from 'bun:test';
import {
  withoutPostbackActions,
  buildAccessRequestNoticeCard,
  buildAgentPickerCard,
  buildAnswerCard,
  buildConnectedCard,
  buildConnectSentPrivatelyCard,
  buildHomeCard,
  buildModelPickerCard,
  buildOpenSessionCard,
  buildProjectsCard,
  buildConnectAccountCard,
  buildPanelCard,
  buildSessionsCard,
  buildTeamsApprovalOutcomeCard,
  buildWelcomeCard,
  openPanelAction,
  buildFinalCard,
  buildPlanCard,
  buildQuestionCard,
  buildRequestAccessCard,
  buildReviewCard,
  buildSelectCard,
} from '../services/channels/teams/cards';
import type { StreamTaskChunk } from '../services/channels/slack-api';

function step(over: Partial<StreamTaskChunk>): StreamTaskChunk {
  return { type: 'task_update', id: 'step-0', title: 'Reading logs', status: 'in_progress', ...over };
}

function texts(card: Record<string, unknown>): string[] {
  return (card.body as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'TextBlock')
    .map((b) => b.text ?? '');
}

function actions(card: Record<string, unknown>): Array<{ type: string; verb?: string; url?: string; data?: Record<string, unknown> }> {
  return (card.actions as Array<{ type: string; verb?: string; url?: string; data?: Record<string, unknown> }>) ?? [];
}

function allExecuteActions(
  node: unknown,
): Array<{ type: string; title?: string; verb?: string; data?: Record<string, unknown> }> {
  const out: Array<{ type: string; title?: string; verb?: string; data?: Record<string, unknown> }> = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (o.type === 'Action.Execute') out.push(o as (typeof out)[number]);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(node);
  return out;
}

describe('buildPlanCard', () => {
  test('is a versioned AdaptiveCard with a title + a line per step', () => {
    const card = buildPlanCard('Working on it…', [
      step({ id: 'step-0', title: 'Reading logs', status: 'complete' }),
      step({ id: 'step-1', title: 'Drafting summary', status: 'in_progress' }),
    ]);
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.5');
    const lines = texts(card);
    expect(lines[0]).toBe('Working on it…');
    expect(lines.some((t) => t.includes('✓') && t.includes('Reading logs'))).toBe(true);
    expect(lines.some((t) => t.includes('⏳') && t.includes('Drafting summary'))).toBe(true);
  });

  test('renders detail + output subtitles when present', () => {
    const card = buildPlanCard('t', [step({ details: 'from Datadog', output: 'found 3' })]);
    const lines = texts(card);
    expect(lines).toContain('from Datadog');
    expect(lines).toContain('found 3');
  });
});

describe('buildFinalCard', () => {
  test('marks an error step with ✗ and appends the body + session link', () => {
    const card = buildFinalCard({
      title: 'Run failed',
      steps: [step({ status: 'error', title: 'Build' })],
      body: 'It broke.',
      sessionUrl: 'https://app/session',
    });
    const lines = texts(card);
    expect(lines[0]).toBe('Run failed');
    expect(lines.some((t) => t.includes('✗') && t.includes('Build'))).toBe(true);
    expect(lines).toContain('It broke.');
    expect(lines.some((t) => t.includes('https://app/session'))).toBe(true);
  });
});

describe('buildAnswerCard', () => {
  test('is a single-body card, with the link only when provided', () => {
    expect(texts(buildAnswerCard('hello'))).toEqual(['hello']);
    expect(texts(buildAnswerCard('hello', 'https://app/s')).some((t) => t.includes('https://app/s'))).toBe(true);
  });

  // Both answer paths — the live card's final edit and a fresh answer card —
  // show a connect link as a button between the answer and the session link.
  test('a connect link in the answer is a button above the session link, on both answer paths', () => {
    const connect = 'https://app.example.test/connect/ksl_c3ludGhldGlj';
    const body = `Gmail is not connected yet.\n\n[Connect Gmail](${connect})`;
    for (const card of [
      buildAnswerCard(body, 'https://app/s'),
      buildFinalCard({ title: 'Task complete', steps: [step({ status: 'complete' })], body, sessionUrl: 'https://app/s' }),
    ]) {
      const els = card.body as Array<{ type: string; text?: string; actions?: Array<Record<string, unknown>> }>;
      const row = els.findIndex((e) => e.type === 'ActionSet');
      expect(els[row].actions).toEqual([{ type: 'Action.OpenUrl', title: 'Connect Gmail', url: connect }]);
      expect(els[row - 1].text).toBe('Gmail is not connected yet.');
      expect(els[els.length - 1].text).toContain('https://app/s');
      expect(texts(card).join('\n')).not.toContain('ksl_');
    }
  });
});

describe('interactive cards', () => {
  test('connect-account card carries an OpenUrl login action', () => {
    const a = actions(buildConnectAccountCard('https://app/teams/login/tok'));
    expect(a[0]?.type).toBe('Action.OpenUrl');
    expect(a[0]?.url).toBe('https://app/teams/login/tok');
  });

  test('request-access card carries an Execute action with the projectId', () => {
    const a = actions(buildRequestAccessCard('proj-1'));
    expect(a[0]?.type).toBe('Action.Execute');
    expect(a[0]?.verb).toBe('teams_request_access');
    expect(a[0]?.data?.projectId).toBe('proj-1');
  });

  test('select card renders one per-row Execute action, marks the current option', () => {
    const card = buildSelectCard({
      emoji: '🧠',
      title: 'Model',
      verb: 'teams_set_model',
      options: [
        { label: 'a', current: true, data: { model: 'a' } },
        { label: 'b', current: false, data: { model: 'b' } },
        { label: 'c', current: false, data: { model: 'c' } },
      ],
    });
    const execs = allExecuteActions(card);
    expect(execs).toHaveLength(3);
    expect(execs.every((x) => x.verb === 'teams_set_model')).toBe(true);
    expect(execs.map((x) => (x.data as { model?: string }).model)).toEqual(['a', 'b', 'c']);
    expect(execs[0]!.title).toContain('In use');
    expect(execs[1]!.title).toBe('Use');
  });

  test('question card turns option labels into answer actions', () => {
    const card = buildQuestionCard([{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }]);
    const a = actions(card);
    expect(a.map((x) => x.data?.answer)).toEqual(['Yes', 'No']);
    expect(a.every((x) => x.verb === 'teams_answer')).toBe(true);
  });

  test('review card carries approve/changes/deny execute actions + a view link', () => {
    const card = buildReviewCard({ reviewItemId: 'r1', title: 'Deploy', summary: 'ship', risk: 'high', viewUrl: 'https://app/r' });
    const a = actions(card);
    const verdicts = a.filter((x) => x.type === 'Action.Execute').map((x) => x.data?.verdict);
    expect(verdicts).toEqual(['approve', 'changes', 'reject']);
    expect(a.some((x) => x.type === 'Action.OpenUrl' && x.url === 'https://app/r')).toBe(true);
  });
});

describe('step citations + answer card', () => {
  test('a completed step renders its sources as a footer of links', () => {
    const card = buildPlanCard('Working on it…', [
      step({
        status: 'complete',
        title: 'Reading the incident logs',
        sources: [
          { type: 'url', url: 'https://kortix.com/a', text: 'incident 42' },
          { type: 'url', url: 'https://kortix.com/b', text: 'deploy log' },
        ],
      }),
    ]);
    const flat = JSON.stringify(card);
    expect(flat).toContain('[incident 42](https://kortix.com/a)');
    expect(flat).toContain('[deploy log](https://kortix.com/b)');
  });

  test('buildAnswerCard renders a provided Adaptive Card verbatim instead of the text body', () => {
    const custom = { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Custom!' }] };
    const card = buildAnswerCard('fallback text', 'https://app/s', custom) as { type: string; body: unknown[] };
    expect(card.type).toBe('AdaptiveCard');
    const flat = JSON.stringify(card);
    expect(flat).toContain('Custom!');
    expect(flat).not.toContain('fallback text');
    // The session link is still appended so the reader can open the run.
    expect(flat).toContain('https://app/s');
  });
})

// Slack parity (2026-09-29 audit): the Teams cards that showed less than their
// Slack counterparts, or dropped choices outright.
describe('Slack parity cards', () => {
  const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `agent-${i + 1}`, description: `Agent ${i + 1}` }));
  const executes = (c: Record<string, unknown>) => allExecuteActions(c);

  test('an agent picker lists every agent: buttons up to 8 choices, then one searchable dropdown', () => {
    const small = buildAgentPickerCard({ agents: agents(7), current: null });
    expect(executes(small).map((a) => a.data?.agent)).toEqual(['', ...agents(7).map((a) => a.name)]);

    const large = buildAgentPickerCard({ agents: agents(12), current: 'agent-9' });
    const dropdown = (large.body as Array<Record<string, unknown>>).find((e) => e.type === 'Input.ChoiceSet')!;
    expect(dropdown).toMatchObject({ id: 'agent', style: 'filtered', value: 'agent-9' });
    expect((dropdown.choices as Array<{ value: string }>).map((c) => c.value)).toEqual(['', ...agents(12).map((a) => a.name)]);
    expect(actions(large)).toEqual([expect.objectContaining({ type: 'Action.Execute', verb: 'teams_set_agent' })]);
  });

  test('the /status panel carries its change buttons before "Open in Kortix"', () => {
    const c = buildPanelCard({
      title: 'This conversation',
      rows: [{ label: 'Model', value: 'default' }],
      url: 'https://app/p',
      actions: [openPanelAction('Change model', 'models'), openPanelAction('Change agent', 'agents')],
    });
    expect(actions(c).map((a) => [a.type, (a as { title?: string }).title, a.data?.panel])).toEqual([
      ['Action.Execute', 'Change model', 'models'],
      ['Action.Execute', 'Change agent', 'agents'],
      ['Action.OpenUrl', 'Open in Kortix', undefined],
    ]);
    expect(actions(c)[0]).toMatchObject({ verb: 'teams_open_panel' });
  });

  test('/sessions rows open their session, by tapping the row or its button', () => {
    const c = buildSessionsCard([
      { title: 'Fix the flaky test', projectName: 'Demo', status: 'done', when: '5m ago', url: 'https://app/s/1' },
      { title: 'Untitled session', projectName: 'Demo', when: '1h ago', url: 'https://app/s/2' },
    ]);
    const json = JSON.stringify(c);
    expect(json).toContain('Fix the flaky test');
    expect(json).toContain('Demo · done · 5m ago');
    expect(json).toContain('Demo · 1h ago');
    const opens = json.match(/"url":"https:\/\/app\/s\/1"/g) ?? [];
    expect(opens).toHaveLength(2);
  });

  test('a review card words its buttons by kind, as Slack does', () => {
    const labels = (kind?: string) =>
      actions(buildReviewCard({ reviewItemId: 'r1', title: 'T', summary: 'S', risk: 'none', kind })).map((a) => (a as { title?: string }).title);
    expect(labels('change')).toEqual(['Ship it', 'Request changes', 'Reject']);
    expect(labels('decision')).toEqual(['Answer', 'Request changes']);
    expect(labels('approval')).toEqual(['Approve', 'Request changes', 'Deny']);
    expect(labels(undefined)).toEqual(['Approve', 'Request changes', 'Deny']);
  });

  test('the welcome card suggests three tasks to try', () => {
    const json = JSON.stringify(buildWelcomeCard({}));
    expect(json).toContain('summarize this thread and draft a reply to the customer');
    expect(json).toContain('put together a one-pager on our Q2 numbers');
  });

  test('an approval outcome names who decided', () => {
    expect(texts(buildTeamsApprovalOutcomeCard({ actionPath: 'gmail.send', decision: 'approve', note: '', decidedBy: 'Alex Example' }))).toContain('by Alex Example');
    expect(texts(buildTeamsApprovalOutcomeCard({ actionPath: 'gmail.send', decision: 'deny', note: '' }))).not.toContain('by ');
  });

  test('an agent-built card keeps the run\'s steps above it', () => {
    const custom = { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Custom body' }] };
    const withPlan = buildAnswerCard('', 'https://app/s', custom, { title: 'Task complete', steps: [step({ status: 'complete', title: 'Read the logs' })] });
    const lines = texts(withPlan);
    expect(lines[0]).toBe('Task complete');
    expect(lines.findIndex((t) => t.includes('Read the logs'))).toBeLessThan(lines.indexOf('Custom body'));
    expect((withPlan.body as Array<Record<string, unknown>>).find((e) => e.text === 'Custom body')).toMatchObject({ separator: true });
    // No live card, no steps: the custom card is used as sent.
    expect(texts(buildAnswerCard('', undefined, custom))).toEqual(['Custom body']);
  });
});

// Slack parity, part 2: home, projects with previews, grouped models, and the
// 1:1 notices (connected, access requested, sign-in sent privately).
describe('Slack parity cards, part 2', () => {
  const project = (n: number, extra: Record<string, unknown> = {}) => ({
    projectId: `p${n}`, name: `Project ${n}`, repo: `acme/repo-${n}`,
    imageUrl: `https://opengraph.githubassets.com/1/acme/repo-${n}`, url: `https://app/p${n}`, ...extra,
  });
  const images = (c: Record<string, unknown>) => (JSON.stringify(c).match(/"type":"Image"/g) ?? []).length;

  test('/projects rows show the repo, its preview, Open, and Use (✓ on the current one)', () => {
    const c = buildProjectsCard([project(1, { current: true }), project(2)]);
    const json = JSON.stringify(c);
    expect(json).toContain('acme/repo-1');
    expect(images(c)).toBe(2);
    const acts = allExecuteActions(c);
    expect(acts.map((a) => [a.title, a.data?.projectId])).toEqual([['✓ In use', 'p1'], ['Use', 'p2']]);
    expect(json.match(/"title":"Open"/g)).toHaveLength(2);
  });

  test('a preview is shown only from an https URL', () => {
    expect(images(buildProjectsCard([project(1, { imageUrl: 'http://example.test/x.png' }), project(2, { imageUrl: null })]))).toBe(0);
  });

  test('the home card lists projects with Open only, then what to try', () => {
    const c = buildHomeCard({ projects: [project(1)] });
    expect(allExecuteActions(c)).toEqual([]);
    const json = JSON.stringify(c);
    expect(json).toContain('Projects in this organization');
    expect(json).toContain('put together a one-pager on our Q2 numbers');
    expect(json).toContain('/login');
    expect(JSON.stringify(buildHomeCard({ projects: [] }))).not.toContain('Projects in this organization');
  });

  test('/sessions rows carry the repo preview', () => {
    expect(images(buildSessionsCard([{ title: 'T', projectName: 'P', when: 'now', url: 'https://app/s', imageUrl: 'https://opengraph.githubassets.com/1/a/b' }]))).toBe(1);
  });

  test('models are grouped by how they are paid for, in Slack\'s order', () => {
    const models = [
      { id: 'kortix/glm', label: 'GLM', via: 'kortix' as const, providerLabel: 'Kortix' },
      { id: 'anthropic/claude', label: 'Claude', via: 'key' as const, providerLabel: 'Anthropic' },
      { id: 'codex/gpt', label: 'GPT', via: 'chatgpt' as const, providerLabel: 'OpenAI' },
    ];
    const json = JSON.stringify(buildModelPickerCard({ models, current: null, currentLabel: null, defaultLabel: null, scopeNote: 'note' }));
    const order = ['ChatGPT subscriptions', 'GPT', 'API keys', 'Claude', 'Kortix models', 'GLM'].map((t) => json.indexOf(`"text":"${t}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const many = Array.from({ length: 9 }, (_, i) => ({ id: `kortix/m${i}`, label: `M${i}`, via: 'kortix' as const, providerLabel: 'Kortix' }));
    const dropdown = (buildModelPickerCard({ models: [...many, models[2]!], current: null, currentLabel: null, defaultLabel: null, scopeNote: 'n' }).body as Array<Record<string, unknown>>)
      .find((e) => e.type === 'Input.ChoiceSet')!;
    expect((dropdown.choices as Array<{ value: string }>).map((c) => c.value).slice(0, 2)).toEqual(['', 'codex/gpt']);
  });

  test('the connected note: resumed, idle, and linked without access (with Request access)', () => {
    expect(texts(buildConnectedCard({ email: 'alex@example.test', resumed: true, hasAccess: true, projectId: 'p1' })).join(' ')).toContain('Picking up your message now.');
    expect(texts(buildConnectedCard({ email: null, resumed: false, hasAccess: true, projectId: 'p1' })).join(' ')).toContain('Mention me with a task');
    const noAccess = buildConnectedCard({ email: 'alex@example.test', resumed: false, hasAccess: false, projectId: 'p1' });
    expect(texts(noAccess).join(' ')).toContain("can't run this project yet");
    expect(actions(noAccess)).toEqual([expect.objectContaining({ verb: 'teams_request_access', data: expect.objectContaining({ projectId: 'p1' }) })]);
  });

  test('the admin notice links to Members, and the other 1:1 notices say where the link went', () => {
    const notice = buildAccessRequestNoticeCard({ requester: '**alex@example.test**', reviewUrl: 'https://app/projects/p1/customize/members' });
    expect(actions(notice)).toEqual([expect.objectContaining({ type: 'Action.OpenUrl', url: 'https://app/projects/p1/customize/members' })]);
    expect(texts(buildConnectSentPrivatelyCard({ botName: 'Kortix', resumes: true })).join(' ')).toContain('private chat with Kortix');
    expect(actions(buildOpenSessionCard('https://app/s/1'))).toEqual([expect.objectContaining({ type: 'Action.OpenUrl', url: 'https://app/s/1' })]);
  });
});

// An agent can post any Adaptive Card (`teams send --card-file`, `teams post
// --card-file`). A look-alike of Kortix's own Stop, Approve or join card would
// post Kortix's verbs when a person clicks it. Agent cards keep links only.
describe('agent-built cards cannot post back to Kortix', () => {
  const forged = {
    type: 'AdaptiveCard',
    version: '1.5',
    selectAction: { type: 'Action.Execute', verb: 'teams_stop', data: { verb: 'teams_stop', sessionId: 's1' } },
    body: [
      { type: 'TextBlock', text: 'Marko wants to join' },
      {
        type: 'ActionSet',
        actions: [
          { type: 'Action.Execute', title: 'Approve', verb: 'teams_thread_join', data: { verb: 'teams_thread_join', requesterUserId: 'attacker' } },
          { type: 'Action.Submit', title: 'Submit', data: { verb: 'teams_review' } },
        ],
      },
      {
        type: 'Container',
        selectAction: { type: 'Action.Submit', data: { verb: 'teams_approval' } },
        items: [{ type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'Docs', url: 'https://example.test/docs' }] }],
      },
    ],
    actions: [
      { type: 'Action.Execute', title: 'Approve', verb: 'teams_approval' },
      { type: 'Action.OpenUrl', title: 'Open', url: 'https://example.test' },
      { type: 'Action.ShowCard', title: 'More', card: { type: 'AdaptiveCard', actions: [{ type: 'Action.Execute', verb: 'teams_review' }] } },
    ],
  };

  test('post-back buttons are removed everywhere; links and show-cards stay', () => {
    const clean = withoutPostbackActions(forged);
    const json = JSON.stringify(clean);
    expect(json).not.toContain('Action.Execute');
    expect(json).not.toContain('Action.Submit');
    expect(json).toContain('https://example.test/docs');
    expect((clean.actions as Array<{ type: string }>).map((a) => a.type)).toEqual(['Action.OpenUrl', 'Action.ShowCard']);
    // An action set left empty is dropped, since Teams refuses one.
    expect((clean.body as Array<{ type: string }>).map((e) => e.type)).toEqual(['TextBlock', 'Container']);
  });

  test('an agent card delivered as the answer carries no post-back button', () => {
    const answer = buildAnswerCard('', 'https://app/s', forged);
    expect(JSON.stringify(answer)).not.toMatch(/Action\.(Execute|Submit)/);
  });
});
