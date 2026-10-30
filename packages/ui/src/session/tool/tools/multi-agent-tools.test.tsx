import { toolCallBlock } from '@kortix/sdk';
import './register';
import { TooltipProvider } from '../../../primitives/tooltip';
import { ToolRunningContext } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolPart } from '../../../internal/session-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentSpawnTool } from './agent-spawn-tool';
import { KortixActionTool } from './kortix-action-tool';
import { MULTI_AGENT_TOOLS, kortixCardTool, parseKortixToolResult } from './kortix-tool-card';
import { isTeamTaskCall } from './multi-agent-tools';
import { TaskListTool } from './task-list-tool';

// Synthetic values only: every handle, id and text below is invented.

let intlErrors: unknown[] = [];

function render(node: ReactNode, opts: { running?: boolean } = {}) {
  intlErrors = [];
  const tree = opts.running ? <ToolRunningContext.Provider value>{node}</ToolRunningContext.Provider> : node;
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" fallback={false} onError={(error) => intlErrors.push(error)}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{tree}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
  expect(intlErrors).toEqual([]);
  return html;
}

function part(tool: string, state: Record<string, unknown>, input: Record<string, unknown> = {}): ToolPart {
  return { type: 'tool', tool, callID: 'call-1', state: { input, ...state } } as unknown as ToolPart;
}
const running = (tool: string, input: Record<string, unknown> = {}) => toolCallBlock(part(tool, { status: 'running' }, input));
const done = (tool: string, output: unknown, input: Record<string, unknown> = {}) =>
  toolCallBlock(
    part(tool, { status: 'completed', output: typeof output === 'string' ? output : JSON.stringify(output), metadata: {} }, input),
  );

function textOf(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

/** The registered renderer of a name, rendered: what the transcript draws. */
function drawn(name: string, call: ReturnType<typeof done>, opts: { running?: boolean; open?: boolean } = {}) {
  const Component = ToolRegistry.get(name)!;
  return render(<Component call={call} defaultOpen={opts.open} />, opts);
}

const AGENT = (handle: string, relation: string, state: string, extra: Record<string, unknown> = {}) => ({
  handle,
  session_id: `ses-${handle}`,
  short_id: 'ses00001',
  project_id: 'p-1',
  agent_name: 'reviewer',
  title: `${handle} at work`,
  relation,
  state,
  inbound: 'accept',
  can_receive: true,
  ...extra,
});

const SENT = {
  ok: true,
  tool: 'send_message',
  action: 'send',
  card: { title: 'Sent to @reviewer', status: 'done' },
  data: {
    status: 'delivered',
    message: {
      id: 'm_1',
      project_id: 'p-1',
      from_session_id: 'ses-lead',
      from_handle: 'lead',
      to_session_id: 'ses-reviewer',
      to_handle: 'reviewer',
      type: 'message',
      message: 'The schema migration finished. Rebase now.',
      summary: 'Migration finished',
      status: 'delivered',
      notify_when_idle: false,
      created_at: '2026-10-30T12:00:00.000Z',
      decided_at: null,
    },
    to: AGENT('reviewer', 'teammate', 'working'),
    note: 'Sent to reviewer.',
  },
};

const TASK = (seq: number, subject: string, status: string, extra: Record<string, unknown> = {}) => ({
  seq,
  lead_session_id: 'ses-lead',
  subject,
  description: '',
  status,
  owner_handle: null,
  owner_session_id: null,
  blocked_by: [],
  blocked: false,
  created_by_session_id: 'ses-lead',
  created_at: '2026-10-30T12:00:00.000Z',
  updated_at: '2026-10-30T12:00:00.000Z',
  ...extra,
});

describe('registration', () => {
  test('every multi-agent tool has a card renderer', () => {
    for (const name of ['send_message', 'list_agents', 'task_stop']) expect(ToolRegistry.get(name)).toBe(KortixActionTool);
    for (const name of MULTI_AGENT_TOOLS) expect(kortixCardTool(name)).toBe(name);
    expect(kortixCardTool('kortix_agents')).toBe('kortix_agents');
    expect(kortixCardTool('bash')).toBeUndefined();
  });

  test('a result without `tool` takes the call name', () => {
    const raw = JSON.stringify({ ok: true, card: { title: '2 agents', status: 'done' } });
    expect(parseKortixToolResult(raw)).toBeNull();
    expect(parseKortixToolResult(raw, 'list_agents')?.tool).toBe('list_agents');
  });
});

describe('send_message', () => {
  test('running says it sends', () => {
    expect(textOf(drawn('send_message', running('send_message', { to: 'reviewer' }), { running: true }))).toContain('Sending a message…');
  });

  test('done shows the receiver, the preview and that it arrived', () => {
    const text = textOf(drawn('send_message', done('send_message', SENT), { open: true }));
    expect(text).toContain('Sent to @reviewer');
    expect(text).toContain('@reviewer');
    expect(text).toContain('Migration finished');
    expect(text).toContain('Delivered');
    // The agent-facing note repeats a delivery; it shows only when the message did not arrive.
    expect(text).not.toContain('Sent to reviewer.');
  });

  test('a held or refused message says so, with the reason', () => {
    const held = { ...SENT, card: { title: 'Waiting for @reviewer', status: 'needs_you' }, data: { ...SENT.data, status: 'held', note: 'Held until their person approves it.' } };
    const heldText = textOf(drawn('send_message', done('send_message', held)));
    expect(heldText).toContain('Waiting for approval');
    expect(heldText).toContain('Held until their person approves it.');
    const refused = { ...SENT, ok: true, card: { title: 'Not sent', status: 'done' }, data: { status: 'refused', message: null, to: AGENT('reviewer', 'session', 'idle', { can_receive: false }), note: 'Not sent: reviewer refuses messages.' } };
    const refusedText = textOf(drawn('send_message', done('send_message', refused), { open: true }));
    expect(refusedText).toContain('Not sent');
    expect(refusedText).toContain('Not sent: reviewer refuses messages.');
  });
});

describe('list_agents', () => {
  test('lists each agent with its relation and state, never the asking session', () => {
    const result = {
      ok: true,
      tool: 'list_agents',
      action: 'list',
      card: { title: '3 agents you can reach', status: 'done', rows: [{ title: 'card row that the body replaces' }] },
      data: {
        self: AGENT('lead', 'self', 'working'),
        agents: [
          AGENT('lead', 'self', 'working'),
          AGENT('reviewer', 'teammate', 'needs_input'),
          AGENT('writer', 'child', 'completed'),
          AGENT('archivist', 'session', 'idle', { can_receive: false }),
        ],
      },
    };
    const text = textOf(drawn('list_agents', done('list_agents', result), { open: true }));
    expect(text).toContain('@reviewer');
    expect(text).toContain('Teammate');
    expect(text).toContain('Needs input');
    expect(text).toContain('@writer');
    expect(text).toContain('Helper');
    expect(text).toContain('Done');
    expect(text).toContain('Can’t receive messages');
    expect(text).not.toContain('@lead');
    expect(text).not.toContain('card row that the body replaces');
  });

  test('running says it checks the other agents', () => {
    expect(textOf(drawn('list_agents', running('list_agents'), { running: true }))).toContain('Checking the other agents…');
  });
});

describe('team tasks and the older tools that share their names', () => {
  const LIST = {
    ok: true,
    tool: 'task_list',
    action: 'list',
    card: { title: '3 tasks', status: 'done' },
    data: {
      tasks: [
        TASK(1, 'Read the auth module', 'completed', { owner_handle: 'reviewer' }),
        TASK(2, 'Write the fix', 'in_progress', { owner_handle: 'writer' }),
        TASK(3, 'Test the fix', 'pending', { blocked_by: [2], blocked: true }),
      ],
    },
  };

  test('a pi task_list draws its tasks: number, subject, owner, blocker, status', () => {
    const html = drawn('task_list', done('task_list', LIST), { open: true });
    const text = textOf(html);
    expect(html).toContain('data-task-seq="3"');
    expect(text).toContain('#2');
    expect(text).toContain('Write the fix');
    expect(text).toContain('@writer');
    expect(text).toContain('In progress');
    expect(text).toContain('blocked by #2');
    expect(text).toContain('Pending');
  });

  test('a pi task_create draws the one task it made', () => {
    const created = { ok: true, tool: 'task_create', action: 'create', card: { title: 'Added task #4', status: 'done' }, data: TASK(4, 'Ship it', 'pending') };
    const text = textOf(drawn('task_create', done('task_create', created), { open: true }));
    expect(text).toContain('Added task #4');
    expect(text).toContain('#4');
    expect(text).toContain('Ship it');
  });

  test('an older plugin output renders the older tool, not the card', () => {
    const legacy = done('task_list', '## Tasks\n- build the site (running)');
    expect(isTeamTaskCall(legacy)).toBe(false);
    // The older TaskListTool row: its own "Tasks" title, and no card status mark.
    const legacyHtml = drawn('task_list', legacy);
    expect(textOf(legacyHtml)).toContain('Tasks');
    expect(legacyHtml).not.toContain('sr-only">Done');
    const spawn = done('task_create', 'Started task t-1', { description: 'Build it', prompt: 'Build the site' });
    expect(isTeamTaskCall(spawn)).toBe(false);
  });

  test('the dispatcher picks the card for a team task output, the older tool otherwise', () => {
    expect(isTeamTaskCall(done('task_list', LIST))).toBe(true);
    // pi's inputs (extensions/team-tasks.ts): task_create { subject }, task_get / task_update { seq }.
    expect(isTeamTaskCall(running('task_update', { seq: 3, status: 'completed' }))).toBe(true);
    expect(isTeamTaskCall(running('task_update', { seq: 3, claim: true }))).toBe(true);
    expect(isTeamTaskCall(running('task_get', { seq: 1 }))).toBe(true);
    expect(isTeamTaskCall(running('task_create', { subject: 'Ship it' }))).toBe(true);
    // The older plugin tools take neither a subject nor a task number.
    expect(isTeamTaskCall(running('task_create', { description: 'Build it', prompt: 'Build the site' }))).toBe(false);
    expect(isTeamTaskCall(running('task_update', { task_id: 't-1', action: 'start', status: 'completed' }))).toBe(false);
    expect(isTeamTaskCall(running('task_update', { task_id: 't-1', owner: 'writer' }))).toBe(false);
    // pi's task_list {} has no input to tell: the older row draws until its output settles.
    expect(isTeamTaskCall(running('task_list'))).toBe(false);
    // The registry still holds the older renderers' slots, now behind the dispatcher.
    expect(ToolRegistry.get('task_list')).not.toBe(TaskListTool);
    expect(ToolRegistry.get('task_create')).not.toBe(AgentSpawnTool);
  });

  test('a running team task call says it works on the team tasks', () => {
    expect(textOf(drawn('task_update', running('task_update', { seq: 3, status: 'in_progress' }), { running: true }))).toContain(
      'Updating the team tasks…',
    );
  });
});

describe('task_stop', () => {
  const stop = (stopped: boolean, extra: Record<string, unknown> = {}) => ({
    ok: true,
    tool: 'task_stop',
    action: 'stop',
    card: { title: stopped ? 'Stopped @writer' : '@writer had already ended', status: 'done' },
    data: { sessionId: 'ses-writer', handle: 'writer', title: 'Draft the launch post', stopped, ...extra },
  });

  test('running says it stops an agent', () => {
    expect(textOf(drawn('task_stop', running('task_stop', { name: 'writer' }), { running: true }))).toContain('Stopping an agent…');
  });

  test('done names the agent and its work, says it stopped, and opens its session', () => {
    const html = drawn('task_stop', done('task_stop', stop(true)), { open: true });
    const text = textOf(html);
    expect(html).toContain('data-testid="stopped-child-body"');
    expect(text).toContain('@writer');
    expect(text).toContain('Draft the launch post');
    expect(text).toContain('Stopped');
    expect(text).not.toContain('Already ended');
    expect(html).toContain('aria-label="Open session"');
  });

  test('an agent that had already ended says so', () => {
    expect(textOf(drawn('task_stop', done('task_stop', stop(false)), { open: true }))).toContain('Already ended');
  });

  test('a child without a handle is named by its title', () => {
    const text = textOf(drawn('task_stop', done('task_stop', stop(true, { handle: null })), { open: true }));
    expect(text).toContain('Draft the launch post');
    expect(text).not.toContain('@writer ·');
  });
});
