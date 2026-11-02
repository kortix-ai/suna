import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { act } from 'react';
import type { Container, Root } from 'react-dom/client';

// Synthetic values only: every id, name and text below is invented.

const windowObject = new Window({ width: 1280, height: 800 });
const touched = [
  'window',
  'document',
  'navigator',
  'customElements',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
  ...Object.getOwnPropertyNames(windowObject).filter((key) => /^[A-Z]/.test(key) && !(key in globalThis)),
  // Bun ships its own event classes; Radix and React dispatch happy-dom's.
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
];
const originals = touched.map((key) => ({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }));
const shims: Record<string, unknown> = {
  getComputedStyle: windowObject.getComputedStyle.bind(windowObject),
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const key of touched) {
  const value = key in shims ? shims[key] : Reflect.get(windowObject, key);
  if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
afterAll(() => {
  for (const { key, descriptor } of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  windowObject.happyDOM.abort();
});

// The child's row and its view, answered by hand. `useSession` must never run: it would
// move the app's one runtime off the lead's box.
type Row = { data?: unknown; isError?: boolean; error?: unknown };
let row: Row = {};
let view: Record<string, unknown> = {};
const viewCalls: Array<[string, string]> = [];
let sessionMounts = 0;
let retries = 0;
const realReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realReact,
  useProjectSession: () => ({ data: undefined, isError: false, error: null, refetch: async () => {}, ...row }),
  useSessionView: (projectId: string, sessionId: string) => {
    viewCalls.push([projectId, sessionId]);
    return { projectId, sessionId, hasOlder: false, isLoadingOlder: false, loadOlder: async () => {}, retry: () => void retries++, thread: null, ...view };
  },
  useSession: () => {
    sessionMounts += 1;
    throw new Error('useSession must not mount for a sub-agent');
  },
}));
const prompts: Array<{ projectId: string; sessionId: string; body: Record<string, unknown> }> = [];
const stops: string[] = [];
const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  createSessionPrompt: async (projectId: string, sessionId: string, body: Record<string, unknown>) => {
    prompts.push({ projectId, sessionId, body });
    return {};
  },
  stopProjectSession: async (_projectId: string, sessionId: string) => {
    stops.push(sessionId);
    return {};
  },
}));
// The turn renderer has its own tests; here it only marks where each turn lands.
const realTranscript = await import('../thread/transcript');
mock.module('../thread/transcript', () => ({
  ...realTranscript,
  SessionTurn: ({ turn }: { turn: { id: string } }) => <div data-turn={turn.id} />,
}));
mock.module('./legacy-subagent-chat', () => ({
  LegacySubagentChat: ({ sessionId }: { sessionId: string }) => <div data-legacy-chat={sessionId} />,
}));

// React DOM picks its change-event support when it loads: load it after `document` exists.
const { createRoot } = await import('react-dom/client');
const { IntlTestProvider } = await import('../../test-utils/intl');
const { TestUiHost } = await import('../../test-utils/ui-host');
const { SubagentDialogContent } = await import('./subagent-dialog-content');

const PROJECT = 'proj_1';
const LEAD = 'ses_lead';
const CHILD = 'ses_child';
const childRow = (extra: Record<string, unknown> = {}) => ({
  session_id: CHILD,
  agent_handle: 'namer',
  agent_name: 'mykortix',
  status: 'running',
  board_state: 'working',
  working: { state: 'working', since: new Date(Date.now() - 90_000).toISOString(), turn_token: null, pending_delivery: false },
  created_at: '2026-10-30T11:00:00.000Z',
  updated_at: '2026-10-30T11:59:00.000Z',
  ...extra,
});
const producer = { harness: 'pi', harness_version: '1', adapter_version: '1' };
const base = { in_context: true, model: null, usage: null, finish: null, error: null, completed_at: '2026-10-30T11:00:02.000Z', producer };
function thread(texts: string[]) {
  return {
    thread_id: 'thr_child',
    parent_thread_id: null,
    messages: texts.flatMap((text, index) => [
      { ...base, message_id: `u${index}`, seq: index * 2, role: 'user', kind: 'turn', status: 'complete', blocks: [{ type: 'text', id: `ut${index}`, text }], created_at: '2026-10-30T11:00:00.000Z' },
      { ...base, message_id: `a${index}`, seq: index * 2 + 1, role: 'assistant', kind: 'turn', status: 'complete', reply_to: `u${index}`, blocks: [{ type: 'text', id: `at${index}`, text: `Answer ${index}` }], created_at: '2026-10-30T11:00:01.000Z' },
    ]),
  };
}

const roots: Root[] = [];
beforeEach(() => {
  row = { data: childRow() };
  view = { status: 'ready', thread: thread(['Pick a name']) };
  viewCalls.length = 0;
  prompts.length = 0;
  stops.length = 0;
  sessionMounts = 0;
  retries = 0;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  windowObject.document.body.innerHTML = '';
});

async function open(node: ReactNode = <SubagentDialogContent open onOpenChange={() => {}} sessionId={CHILD} title="Name the release" />) {
  const host = windowObject.document.createElement('div');
  windowObject.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () =>
    root.render(
      <IntlTestProvider locale="en" onError={() => {}}>
        <QueryClientProvider client={new QueryClient()}>
          <TestUiHost params={{ id: PROJECT, sessionId: LEAD }}>{node}</TestUiHost>
        </QueryClientProvider>
      </IntlTestProvider>,
    ),
  );
  const body = windowObject.document.body;
  return {
    dialog: () => body.querySelector('[data-testid="subagent-dialog"]'),
    text: () => body.querySelector('[data-testid="subagent-dialog"]')?.textContent ?? '',
    q: (selector: string) => body.querySelector(selector) as unknown as HTMLElement | null,
  };
}

describe('SubagentDialog: a child that is its own project session', () => {
  test("mounts the child's own view, never useSession, with the header the agents line uses", async () => {
    const dom = await open();
    expect(dom.dialog()).not.toBeNull();
    expect(dom.dialog()!.getAttribute('data-body')).toBe('peek');
    // The child's own log, from the API: never the lead's, never a runtime mount.
    expect(viewCalls.at(-1)).toEqual([PROJECT, CHILD]);
    expect(sessionMounts).toBe(0);
    const text = dom.text();
    expect(text).toContain('namer');
    expect(text).toContain('runs as My Kortix');
    expect(text).toContain('working · 1m');
    expect(dom.q('[data-turn="u0"]')).not.toBeNull();
    expect(dom.q('a[href="/projects/proj_1/sessions/ses_child"]')?.textContent).toContain('Open page');
    expect(dom.q('[aria-label="Stop namer"]')).not.toBeNull();
    expect(dom.q('[aria-label="Close"]')).not.toBeNull();
  });

  test('Stop stops the child, and shows only while it works', async () => {
    const dom = await open();
    await act(async () => dom.q('[aria-label="Stop namer"]')!.click());
    expect(stops).toEqual([CHILD]);
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    windowObject.document.body.innerHTML = '';
    row = { data: childRow({ board_state: 'completed', status: 'completed' }) };
    const done = await open();
    expect(done.text()).toContain('done');
    expect(done.q('[aria-label="Stop namer"]')).toBeNull();
  });

  test('the message box sends to the child as a steer', async () => {
    const dom = await open();
    const input = dom.q('[data-testid="subagent-dialog-message"]') as unknown as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe('Message namer…');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(windowObject.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Use a shorter name');
      input.dispatchEvent(new windowObject.Event('input', { bubbles: true }) as unknown as Event);
    });
    await act(async () => {
      input.closest('form')!.dispatchEvent(new windowObject.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      projectId: PROJECT,
      sessionId: CHILD,
      body: { delivery: 'steer', parts: [{ type: 'text', text: 'Use a shorter name' }] },
    });
  });
});

describe('SubagentDialog: never a blank body', () => {
  test('a skeleton while the log loads', async () => {
    view = { status: 'loading', thread: null };
    const dom = await open();
    expect(dom.q('[data-testid="session-peek"][data-status="loading"] [aria-busy="true"]')).not.toBeNull();
  });

  test('a failed read says so; Try again reads again', async () => {
    view = { status: 'error', thread: null };
    const dom = await open();
    expect(dom.text()).toContain('Could not load this agent’s messages');
    const retry = [...windowObject.document.querySelectorAll('button')].find((node) => node.textContent === 'Try again')!;
    await act(async () => (retry as unknown as HTMLButtonElement).click());
    expect(retries).toBe(1);
  });

  test('a child with no message yet says "Nothing yet"', async () => {
    view = { status: 'empty', thread: null };
    const dom = await open();
    expect(dom.text()).toContain('Nothing yet');
  });

  test('a skeleton while the child row loads', async () => {
    row = {};
    const dom = await open();
    expect(dom.dialog()!.getAttribute('data-body')).toBe('loading');
    expect(dom.q('[data-testid="subagent-dialog"] [aria-busy="true"]')).not.toBeNull();
  });
});

describe('SubagentDialog: a child that is not a project session', () => {
  test('a 404 for the child row keeps the legacy chat of the lead computer, with no message box', async () => {
    row = { isError: true, error: Object.assign(new Error('Not found'), { status: 404 }) };
    const dom = await open();
    expect(dom.dialog()!.getAttribute('data-body')).toBe('legacy');
    expect(dom.q(`[data-legacy-chat="${CHILD}"]`)).not.toBeNull();
    expect(dom.q('[data-testid="subagent-dialog-message"]')).toBeNull();
    expect(dom.text()).toContain('Name the release');
  });

  test('any other failure is an error with Try again, not the legacy chat', async () => {
    row = { isError: true, error: Object.assign(new Error('Server error'), { status: 500 }) };
    const dom = await open();
    expect(dom.dialog()!.getAttribute('data-body')).toBe('error');
    expect(dom.q('[data-legacy-chat]')).toBeNull();
    expect(dom.text()).toContain('Try again');
  });
});
