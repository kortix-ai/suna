/**
 * "Show work" under a messages-only thread's agent message, clicked on
 * happy-dom: it opens the turn's folded work inline (a thread) or the worker
 * sessions the turn started (a talk-only thread), and closes again.
 * transcript-messages-only.test.tsx pins the closed markup.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
// The diff renderer registers a web component at import.
globals.customElements = win.customElements;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

const { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurns, toolCallBlock } = await import('@kortix/sdk');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { TooltipProvider } = await import('../../primitives/tooltip');
const { IntlTestProvider } = await import('../../test-utils/intl');
await import('../tool/tools/register');
const { SessionTurn } = await import('./transcript');
const { TranscriptRowsContext } = await import('./transcript-rows');
const { SessionIdsProvider } = await import('../../providers/session-ids');

type SessionLogMessage = import('@kortix/sdk').SessionLogMessage;
type SessionLogTurn = import('@kortix/sdk').SessionLogTurn;
type TranscriptRows = import('./transcript-rows').TranscriptRows;

function message(id: string, role: 'user' | 'assistant', blocks: SessionLogMessage['blocks'], extra: Partial<SessionLogMessage> = {}): SessionLogMessage {
  return {
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: id, thread_id: 'synthetic', seq: 1,
    role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
    finish: null, error: null, created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:30Z',
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks, ...extra,
  };
}

function call(id: string, name: string, input: Record<string, unknown>, output: string): SessionLogMessage['blocks'][number] {
  return {
    type: 'tool_call', id, call_id: id, name, kind: 'other', input, status: 'complete',
    result: { content: [{ type: 'text', text: output }], is_error: false },
    started_at: '2026-01-01T00:00:01Z', ended_at: '2026-01-01T00:00:20Z',
  };
}

function turnOf(messages: SessionLogMessage[]): SessionLogTurn {
  const [turn] = sessionLogTurns({
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'synthetic', parent_thread_id: null, spawned_by: null,
    agent: null, title: null, created_at: '', messages,
  });
  if (!turn) throw new Error('Missing synthetic turn');
  return turn;
}

const ROWS: TranscriptRows = {
  agent: 'Kortix',
  owner: { name: 'Thread Owner', email: 'owner@example.test', avatarUrl: null },
  unknownAuthor: 'Someone',
  messagesOnly: true,
};

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  win.document.body.innerHTML = '';
});

async function mount(turn: SessionLogTurn, rows: TranscriptRows, projectId = ''): Promise<HTMLElement> {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => {
    root.render(
      <IntlTestProvider locale="en" onError={() => {}}>
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <SessionIdsProvider projectId={projectId} sessionId="synthetic">
              <TranscriptRowsContext.Provider value={rows}>
                <SessionTurn
                  turn={turn} turnOutcome={{}} sessionId="synthetic" sessionStatus={undefined} isLast ownsPlan={false}
                  permissions={[]} questions={[]} sessionWorking={false} isWorkingTurn={false}
                  suppressBusyIndicator={false} awaitingUser={false} pending={false} isFirstTurn
                  onPermissionReply={async () => {}} onRewind={() => {}} rewindDisabled
                />
              </TranscriptRowsContext.Provider>
            </SessionIdsProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </IntlTestProvider>,
    );
  });
  return host as unknown as HTMLElement;
}

function toggle(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-slot="show-work"] > button');
  if (!button) throw new Error('No Show work control');
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  });
}

describe('Show work, clicked', () => {
  const worked = turnOf([
    message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Summarize the synthetic report' }]),
    message('reply', 'assistant', [
      call('sh-1', 'bash', { command: 'cat synthetic-notes.txt' }, 'synthetic notes'),
      { type: 'text', id: 'interim', text: 'Synthetic interim narration' },
      { type: 'text', id: 'answer', text: 'Synthetic final answer' },
    ], { reply_to: 'prompt' }),
  ]);

  test("a thread's message opens its folded work inline and closes it again", async () => {
    const host = await mount(worked, ROWS);
    const button = toggle(host);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Synthetic interim narration');

    await click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain('Hide work');
    const content = host.querySelector('[data-slot="show-work-content"]');
    expect(content).not.toBeNull();
    // The work: the tool row and the interim sentence, never the answer a second time.
    expect(content?.textContent).toContain('Synthetic interim narration');
    expect(content?.textContent).toContain('cat synthetic-notes.txt');
    expect(content?.textContent).not.toContain('Synthetic final answer');
    expect(host.textContent?.match(/Synthetic final answer/g)).toHaveLength(1);

    await click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-slot="show-work-content"]')).toBeNull();
  });

  test("a talk-only thread's message opens the worker session its turn started", async () => {
    const handoff = turnOf([
      message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Find a synthetic flight' }]),
      message('reply', 'assistant', [
        toolCallBlock({
          type: 'tool', id: 'ag-1', tool: 'agent', callID: 'ag-1',
          state: {
            status: 'completed', input: { subagent_type: 'mykortix', name: 'flight-search', description: 'Find a flight', prompt: 'Find a synthetic flight' },
            output: 'started', title: 'Find a flight', metadata: { sessionId: 'ses_synthworker1', background: true }, time: { start: 1, end: 2 },
          },
        } as never),
        { type: 'text', id: 'answer', text: 'On it.' },
      ], { reply_to: 'prompt' }),
    ]);
    const host = await mountInProject(handoff);
    await click(toggle(host));
    const worker = host.querySelector('[data-worker-session]');
    expect(worker?.getAttribute('data-worker-session')).toBe('ses_synthworker1');
    // The hand-off row itself is not the work shown: no "Find a flight" agent row.
    expect(host.querySelector('[data-slot="show-work-content"]')?.textContent).not.toContain('Find a flight');
  });
});

/** `mount` as a talk-only thread under a project id: the worker transcript reads the session through it. */
function mountInProject(turn: SessionLogTurn): Promise<HTMLElement> {
  return mount(turn, { ...ROWS, front: true }, 'synthetic-project');
}
