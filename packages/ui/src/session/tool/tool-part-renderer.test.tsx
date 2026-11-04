import './tools/register';
import { TooltipProvider } from '../../primitives/tooltip';
import type { ToolPart } from '../../internal/session-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../test-utils/intl';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from './shared/infrastructure';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurnSegments, sessionLogTurns, toolCallBlock, type SessionLogBlock, type SessionLogMessage, type ToolCallBlock } from '@kortix/sdk';
import { ToolPartRenderer } from './tool-part-renderer';

/**
 * Task 16 follow-up. `ToolPartRenderer` is the funnel every tool call passes
 * through, and it hands `defaultOpen` / `forceOpen` / `locked` down to whatever
 * component draws the call. Nothing pinned that hand-off, and two of its three
 * branches silently dropped the props — invisible while the panel surface
 * rendered every body unconditionally, and a dead row the moment the panel
 * became a disclosure.
 *
 * The two branches tested here are exactly the two that were broken, and they
 * are the two with no component file of their own to test through:
 *
 *  - the THROWN-ERROR branch, which builds its `BasicTool` inline;
 *  - the FALLBACK branch, `GenericTool`, which draws every unregistered tool —
 *    i.e. every MCP tool a user has connected.
 *
 * Both are asserted on the panel surface, where a closed row means the content
 * is genuinely unreachable, and where `defaultOpen` is what the Advanced panel
 * and a single-call Easy detail both pass.
 */
function withProviders(node: ReactNode) {
  return (
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>
  );
}

function renderPanel(part: ToolPart, opts: { defaultOpen?: boolean } = {}) {
  return renderToStaticMarkup(
    withProviders(
      <ToolSurfaceContext.Provider value="panel">
        <ToolPartRenderer call={toolCallBlock(part)} sessionId="s1" defaultOpen={opts.defaultOpen} />
      </ToolSurfaceContext.Provider>,
    ),
  );
}

const THROWN = {
  type: 'tool',
  tool: 'bash',
  callID: 'call-thrown',
  state: { status: 'error', input: {}, error: 'ENOENT: no such file or directory' },
} as unknown as ToolPart;

// No registered renderer — the shape every MCP tool arrives in.
const UNREGISTERED = {
  type: 'tool',
  tool: 'linear/create_issue',
  callID: 'call-mcp',
  state: {
    status: 'completed',
    input: { title: 'Fix the panel' },
    output: 'Created issue JAY-1234.',
    metadata: {},
  },
} as unknown as ToolPart;


// ── KRTX-1746: a failed subagent dispatch keeps its thread reachable ────────
//
// The reporter's session (screenshot in the Slack thread): the task tool
// failed — "Subagent failed (task_id: ses_…): This model does not support
// assistant message prefill. The conversation must end with a user message." —
// and the row collapsed into the generic error card, whose trigger has no way
// into the child session. The child's transcript survived (OpenCode keeps it;
// the part's `state.metadata.sessionId` names it), so the row must stay a
// dispatch row. The errored-part shape below is the runtime's, read off
// opencode 1.18.23 in a reproduction.
const FAILED_TASK = {
  id: 'part_failed_task',
  sessionID: 'ses_root',
  messageID: 'msg_root',
  type: 'tool',
  tool: 'task',
  callID: 'call-task-1',
  state: {
    status: 'error',
    input: {
      description: 'Report on the widget',
      prompt: 'Write the quarterly report on the widget.',
      subagent_type: 'general',
    },
    metadata: { parentSessionId: 'ses_root', sessionId: 'ses_ee95c107bffe49S04KWqZ5tjcc' },
    error:
      'Subagent failed (task_id: ses_ee95c107bffe49S04KWqZ5tjcc): This model does not support assistant message prefill. The conversation must end with a user message.',
    time: { start: 1, end: 2 },
  },
} satisfies ToolPart;

describe('an errored task dispatch renders as a dispatch row, not a dead error card', () => {
  test('the child thread stays openable and the failure reason stays visible', () => {
    const html = renderPanel(FAILED_TASK);
    // TaskTool's full-view affordance — the way into the child session — lives
    // on the trigger, so it is there even on the closed row.
    expect(html).toContain('aria-label="Open full view"');
    // The row carries the dispatch's own identity again, not "Task failed".
    expect(html).toContain('Report on the widget');
    // And the failure reason is still on the row, as it was on the old card.
    const open = renderPanel(FAILED_TASK, { defaultOpen: true });
    expect(open).toContain('assistant message prefill');
    expect(open).toContain('aria-label="Open full view"');
  });

  test('a task_id in the error keeps the child thread openable without metadata', () => {
    const part: ToolPart = {
      id: 'part-error-only',
      sessionID: 'ses_root',
      messageID: 'msg_root',
      type: 'tool',
      tool: 'task',
      callID: 'call-error-only',
      state: {
        status: 'error',
        input: { description: 'Inspect the widget', subagent_type: 'general' },
        error: 'Subagent failed (task_id: ses_failed123): provider rejected the request',
        time: { start: 1, end: 2 },
      },
    };
    const html = renderPanel(part, { defaultOpen: true });
    expect(html).toContain('aria-label="Open full view"');
    expect(html).toContain('provider rejected the request');
  });

  test('an errored task without a child id keeps the generic error card', () => {
    const orphan = {
      ...FAILED_TASK,
      state: {
        ...FAILED_TASK.state,
        metadata: {},
        error: 'Unknown agent type: nope',
      },
    } satisfies ToolPart;
    const html = renderPanel(orphan);
    expect(html).not.toContain('Open full view');
    // The generic card's own trigger: humanized tool name + "failed".
    expect(html).toContain('>Task</span>');
    expect(html).toContain('title="failed"');
  });

  test('an errored bash call keeps the generic error card (no child thread)', () => {
    const html = renderPanel(THROWN);
    expect(html).not.toContain('Open full view');
    expect(html).toContain('>Bash</span>');
    const open = renderPanel(THROWN, { defaultOpen: true });
    expect(open).toContain('ENOENT: no such file or directory');
  });
});

describe('ToolPartRenderer forwards the open props to every branch', () => {
  test('a thrown error opens with defaultOpen — the error text IS the content', () => {
    const html = renderPanel(THROWN, { defaultOpen: true });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('ENOENT: no such file or directory');
  });

  test('without defaultOpen the errored row is closed, but still openable', () => {
    const html = renderPanel(THROWN);

    // Closed — and a real control, not the dead row a dropped prop produced.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('ENOENT: no such file or directory');
  });

  test('an unregistered (MCP) tool opens with defaultOpen — GenericTool gets the prop', () => {
    const html = renderPanel(UNREGISTERED, { defaultOpen: true });

    // GenericTool's own trigger, so the fallback really is what rendered.
    expect(html).toContain('Create Issue');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Created issue JAY-1234.');
  });

  test('without defaultOpen the unregistered row is closed, but still openable', () => {
    const html = renderPanel(UNREGISTERED);

    expect(html).toContain('Create Issue');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('Created issue JAY-1234.');
  });
});

/**
 * The two render tests above cover the two branches that actually broke. This
 * covers the other ~60 call sites they cannot reach.
 *
 * Sixteen renderers had already silently dropped `defaultOpen` before the panel
 * became a disclosure — harmless then, a dead row now — and two more slipped
 * through the conversion itself. The failure is invisible by construction: the
 * row still renders, just shut, so nothing throws and nothing looks broken
 * until you click it. A source sweep is the only guard that scales to every
 * renderer without a render test per tool.
 *
 * The rule is narrow on purpose: a `<BasicTool>` WITH children must mention
 * BOTH `defaultOpen` and `forceOpen` among its props. A self-closing one has
 * nothing to open and is exempt (`agent-stop`, `project-delete`). What the
 * value is — the prop, a literal, an `||` of both — is the renderer's business.
 *
 * `forceOpen` is swept for the same reason and a sharper one. `defaultOpen`
 * only seeds the row, so dropping it costs a click. `forceOpen` LATCHES it
 * open (`BasicTool` seeds `useState(defaultOpen || !!forceOpen)` and re-opens
 * on every change), which is how a tool that needs an answer — a permission
 * prompt, an ask — puts its own question on screen. Drop it and the prompt is
 * behind a shut row the reader has no reason to click, so the run just stalls.
 * Nine body-bearing renderers were dropping it when this half of the rule went
 * in, among them `project-create`, `project-select`, `session-message`,
 * `session-stats`, `task-list`. Two of those (`session-message`, `task-list`)
 * hardcode `defaultOpen={false}` — which is exactly the shape where the latch
 * is the only way the row ever opens by itself.
 */
describe('every BasicTool with a body accepts defaultOpen and forceOpen', () => {
  const toolDir = join(__dirname, 'tools');
  const sources: [string, string][] = [
    ...readdirSync(toolDir)
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .sort()
      .map((f): [string, string] => [`tools/${f}`, readFileSync(join(toolDir, f), 'utf8')]),
    ['generic-tool.tsx', readFileSync(join(__dirname, 'generic-tool.tsx'), 'utf8')],
    ['tool-part-renderer.tsx', readFileSync(join(__dirname, 'tool-part-renderer.tsx'), 'utf8')],
  ];

  /** Every `<BasicTool …>` open tag in `source`, as `{ props, selfClosing }`. */
  function openTags(source: string): { props: string; selfClosing: boolean; line: number }[] {
    const tags: { props: string; selfClosing: boolean; line: number }[] = [];
    for (const match of source.matchAll(/<BasicTool\b/g)) {
      const start = match.index + match[0].length;
      // Scan to the `>` that closes the tag, ignoring any inside a `{…}` prop
      // value (every trigger object and JSX-node trigger contains `>`).
      let depth = 0;
      let i = start;
      for (; i < source.length; i++) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      const selfClosing = source[i - 1] === '/';
      tags.push({
        props: source.slice(start, selfClosing ? i - 1 : i),
        selfClosing,
        line: source.slice(0, match.index).split('\n').length,
      });
    }
    return tags;
  }

  test('the sweep finds the call sites it claims to check (it is not silently empty)', () => {
    const total = sources.reduce((n, [, src]) => n + openTags(src).length, 0);
    expect(total).toBeGreaterThan(50);
    // And it can tell the two shapes apart — otherwise the rule below is vacuous.
    const bodied = sources.flatMap(([, src]) => openTags(src)).filter((t) => !t.selfClosing);
    expect(bodied.length).toBeGreaterThan(40);
    expect(bodied.length).toBeLessThan(total);
  });

  /** Every body-bearing `<BasicTool>` whose props omit `prop`, as `file:line`. */
  function gapsFor(prop: string): string[] {
    return sources.flatMap(([name, src]) =>
      openTags(src)
        .filter((t) => !t.selfClosing && !t.props.includes(prop))
        .map((t) => `${name}:${t.line}`),
    );
  }

  test('no body-bearing call site drops defaultOpen', () => {
    expect(gapsFor('defaultOpen')).toEqual([]);
  });

  test('no body-bearing call site drops forceOpen', () => {
    expect(gapsFor('forceOpen')).toEqual([]);
  });
});

describe('a command saved before tool calls were kept 1:1', () => {
  // The old mirror kept a call's status, title, time and metadata, and lost
  // its input and output. OpenCode titles a command with the command and keeps
  // its output in `metadata.output`, so the API serves the row with both
  // restored (`restoreStrippedToolParts`). This is that served shape.
  test('draws its command and its output through the bash renderer', () => {
    const served = {
      type: 'tool',
      tool: 'bash',
      callID: 'call-restored',
      state: {
        status: 'completed',
        title: 'ls -la dist',
        time: { start: 1, end: 2 },
        metadata: { output: 'bundle.min.js', exit: 0, truncated: false },
        input: { command: 'ls -la dist' },
        output: 'bundle.min.js',
      },
    } as unknown as ToolPart;
    const html = renderPanel(served, { defaultOpen: true });
    expect(html).toContain('-la');
    expect(html).toContain('dist');
    expect(html).toContain('bundle.min.js');
  });
});

describe('a codemode script\'s nested image_gen call on v2 (a pi nested_part block)', () => {
  const nestedImage = {
    type: 'harness', id: 'n1', harness: 'pi', kind: 'nested_part', model_visible: false,
    data: {
      parent_call_id: 'call_code',
      part: {
        type: 'tool', callID: 'call_code/1', tool: 'image_gen',
        state: { status: 'completed', input: { action: 'generate', prompts: ['cube'] }, output: '{"action":"generate","model":"m","provider":"p","images":[{"path":"/workspace/output/images/cube.png","size":"1024x1024","prompt":"cube"}]}', title: 'image_gen', metadata: {}, time: { start: 1, end: 2 } },
      },
    },
  } as const;
  const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
  const message = (id: string, role: 'user' | 'assistant', blocks: SessionLogBlock[], seq: number): SessionLogMessage => ({
    ...V, message_id: id, thread_id: 't', seq, role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
    finish: null, error: null, created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), completed_at: null,
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1.2.0' }, blocks, ...(role === 'assistant' && { reply_to: 'u' }),
  });

  test('the transcript\'s segment for the block renders the image card without throwing', () => {
    const turn = sessionLogTurns({
      ...V, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '',
      messages: [
        message('u', 'user', [{ type: 'text', id: 'q', text: 'go' }], 1),
        message('a', 'assistant', [{ type: 'tool_call', id: 'c', call_id: 'call_code', name: 'codemode', kind: 'code', input: { code: 'x' }, status: 'complete', result: { content: [{ type: 'text', text: 'ok' }], is_error: false } }, nestedImage as unknown as SessionLogBlock], 2),
      ],
    })[0]!;
    const segment = sessionLogTurnSegments(turn.blocks).find((s) => s.kind === 'standalone') as { block: ToolCallBlock };
    expect(segment.block.name).toBe('image_gen');
    const html = renderToStaticMarkup(withProviders(<ToolPartRenderer call={segment.block} sessionId="s1" />));
    // The image card (its file loads on the client): a figure, not the generic row or an error.
    expect(html).toContain('<figure');
    expect(html).toContain('Loading image');
  });

  test('a block that is not a tool call (no state) renders nothing and never throws', () => {
    const html = renderToStaticMarkup(withProviders(<ToolPartRenderer call={nestedImage as unknown as ToolCallBlock} sessionId="s1" />));
    expect(html).toBe('');
  });
});
