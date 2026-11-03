import { sessionLogOfV1Rows, toolCallBlock } from '@kortix/sdk';
import './register';
import { TooltipProvider } from '../../../primitives/tooltip';
import {
  BoundActivateContext,
  ToolSurfaceContext,
} from '../shared/infrastructure';
import type { MessageWithParts, ToolPart } from '../../../internal/session-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The contract this file pins (spec W7, replacing the previous one).
 *
 * A task call is a DISCLOSURE row whose body is the sub-agent's live activity.
 * It used to be a plain clickable row: clicking anywhere on it opened
 * `SubagentDialog`, so the one thing the reader wants while a sub-agent runs —
 * what it is doing — was reachable only by leaving the transcript for a modal,
 * and the `SubAgentActivity` the component already built was dead code on that
 * path. Now the row expands in place and the modal is an explicit action inside
 * the body.
 *
 * `role="button"` is on BOTH shapes and so proves nothing: `ClickableToolRow`
 * and `DisclosureTrigger` each set it. `aria-expanded` is the discriminator —
 * only the disclosure has an open state to report.
 *
 * The harness renders to static markup (this app has no DOM in tests — no
 * jsdom, no happy-dom, no react-test-renderer), so a click cannot be dispatched
 * here and a `useState` flip cannot be observed. What IS asserted is everything
 * the click depends on: the action is rendered, it sits in the disclosure body,
 * and the modal it opens is mounted and wired to this call's child session and
 * title. `SubagentDialog` is stubbed so those props are visible in the markup —
 * the real one renders nothing while closed.
 *
 * `mock.module` is process-wide in this workspace, so both mocks spread the real
 * module and the `useSessionLogThread` stub answers only for THIS file's child
 * thread: the `fromV1` view of `childMessages`, as the hook serves a v1 session.
 * Every other thread falls through to the real hook.
 */

const CHILD_SESSION_ID = 'ses_child1';

let childMessages: MessageWithParts[] | undefined;

const realSdkReact = await import('@kortix/sdk/react');
const { useSessionLogThread } = realSdkReact;
await mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useSessionLogThread: (...args: Parameters<typeof useSessionLogThread>) => {
    const real = useSessionLogThread(...args);
    if (args[1] !== CHILD_SESSION_ID) return real;
    return childMessages?.length ? sessionLogOfV1Rows('', CHILD_SESSION_ID, childMessages).threads[0] : null;
  },
}));

const realSubagentView = await import('../../agents/subagent-view');
await mock.module('../../agents/subagent-view', () => ({
  ...realSubagentView,
  SubagentDialog: ({
    open,
    sessionId,
    title,
  }: {
    open: boolean;
    sessionId: string;
    title?: string;
  }) => (
    <div
      data-subagent-dialog
      data-open={String(open)}
      data-session-id={sessionId}
      data-title={title}
    />
  ),
}));

const { TaskTool } = await import('./task-tool');

function childToolPart(tool: string, input: Record<string, unknown>, callID: string) {
  return {
    type: 'tool',
    tool,
    callID,
    state: { status: 'completed', input, output: '', metadata: {}, time: { start: 1, end: 2 } },
  };
}

/** What the runtime sends back for a child session: assistant messages with tool parts. */
const CHILD_MESSAGES = [
  {
    info: { id: 'm1', role: 'assistant', sessionID: CHILD_SESSION_ID },
    parts: [
      childToolPart('grep', { pattern: 'TODO' }, 'child-1'),
      childToolPart('glob', { pattern: '**/*.ts' }, 'child-2'),
    ],
  },
] as unknown as MessageWithParts[];

function taskPart(overrides: {
  status?: string;
  childSessionId?: string | null;
  input?: Record<string, unknown>;
}): ToolPart {
  const { status = 'completed', childSessionId = CHILD_SESSION_ID, input } = overrides;
  return {
    type: 'tool',
    tool: 'task',
    callID: 'call-1',
    state: {
      status,
      input: input ?? { subagent_type: 'explorer', description: 'Find the bug' },
      output: '',
      metadata: childSessionId ? { sessionId: childSessionId } : {},
      time: { start: 1, end: 2 },
    },
  } as unknown as ToolPart;
}

function withProviders(node: ReactNode) {
  return (
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>
  );
}

function render(
  part: ToolPart,
  opts: {
    open?: boolean;
    panel?: boolean;
    forceOpen?: boolean;
    locked?: boolean;
    /** Bind the chat's "open this tool in the side panel" context. */
    activatable?: boolean;
  } = {},
) {
  let tool = (
    <TaskTool call={toolCallBlock(part)} defaultOpen={opts.open} forceOpen={opts.forceOpen} locked={opts.locked} />
  );
  if (opts.activatable) {
    tool = <BoundActivateContext.Provider value={() => {}}>{tool}</BoundActivateContext.Provider>;
  }
  return renderToStaticMarkup(
    withProviders(
      opts.panel ? (
        <ToolSurfaceContext.Provider value="panel">{tool}</ToolSurfaceContext.Provider>
      ) : (
        tool
      ),
    ),
  );
}

const { ToolRegistry } = await import('../shared/registry');

describe('TaskTool — one card, one way in', () => {
  test('a call with a child session is one card button: what it was asked, the agent, its state, Open', () => {
    childMessages = undefined;
    const markup = render(taskPart({}));
    expect(markup).toContain('data-testid="agent-call-card"');
    expect(markup).toContain('aria-label="Open Find the bug"');
    expect(markup).toContain('>Find the bug</span>');
    expect(markup).toContain('>Explorer</span>');
    expect(markup).toContain('>Done</span>');
    expect(markup).toContain('>Open</span>');
    // No disclosure: the steps and the transcript are in the agent pane.
    expect(markup).not.toContain('aria-expanded');
    expect(markup).toContain(`data-session-id="${CHILD_SESSION_ID}"`);
  });

  test('a running call reads Working', () => {
    childMessages = CHILD_MESSAGES;
    expect(render(taskPart({ status: 'running' }))).toContain('>Working</span>');
  });

  test('no child session: a plain card, nothing to open, no dialog', () => {
    childMessages = undefined;
    const markup = render(taskPart({ childSessionId: null }));
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('>Open</span>');
    expect(markup).not.toContain('data-subagent-dialog');
  });

  test('a failed dispatch reads Didn’t finish and shows why under the card', () => {
    childMessages = undefined;
    const failed = taskPart({ status: 'error' }) as ToolPart & { state: { error?: string } };
    failed.state.error = 'Subagent failed: This model does not support assistant message prefill.';
    const markup = render(failed as ToolPart);
    expect(markup).toContain('>Didn’t finish</span>');
    expect(markup).toContain('assistant message prefill');
  });
});

describe('TaskTool — pi agent tool', () => {
  function agentPart(state: Record<string, unknown>): ToolPart {
    return {
      type: 'tool',
      tool: 'agent',
      callID: 'call-agent',
      state: {
        input: { subagent_type: 'researcher', description: 'Read the market report', prompt: 'Read it' },
        output: '',
        time: { start: 1, end: 2 },
        ...state,
      },
    } as unknown as ToolPart;
  }

  test('`agent` resolves to the call card and opens its child session', () => {
    expect(ToolRegistry.get('agent')).toBe(TaskTool);
    childMessages = undefined;
    const markup = render(agentPart({ status: 'completed', metadata: { sessionId: CHILD_SESSION_ID } }));
    expect(markup).toContain('>Read the market report</span>');
    expect(markup).toContain('>Researcher</span>');
    expect(markup).toContain(`data-session-id="${CHILD_SESSION_ID}"`);
  });

  test('a background hand-off whose child still works reads Working, with nothing shimmering', () => {
    childMessages = undefined;
    const markup = render(agentPart({ status: 'completed', metadata: { sessionId: CHILD_SESSION_ID, background: true } }));
    expect(markup).toContain('>Working</span>');
    expect(markup).not.toContain('data-kx-text-shimmer');
  });

  test('once the background child replied, it reads Done', () => {
    childMessages = [
      {
        info: { id: 'm1', role: 'assistant', sessionID: CHILD_SESSION_ID, time: { created: 1, completed: 2 } },
        parts: [{ type: 'text', id: 'p1', text: 'Done.', sessionID: CHILD_SESSION_ID, messageID: 'm1' }],
      },
    ] as unknown as MessageWithParts[];
    const markup = render(agentPart({ status: 'completed', metadata: { sessionId: CHILD_SESSION_ID, background: true } }));
    expect(markup).toContain('>Done</span>');
  });
});
