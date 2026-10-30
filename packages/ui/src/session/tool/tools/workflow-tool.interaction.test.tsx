/**
 * The workflow card's controls, through real events in a DOM (`happy-dom` + `createRoot`,
 * the pattern of `changes/diff-layout-toggle.test.tsx`): the status filter and its `f`
 * key, ↑/↓ between rows, a phase fold, "Show all", a structured answer's JSON, the
 * result fold, and Stop on a running agent, which goes through the SDK's session stop.
 *
 * Synthetic values only: every title, id and session id below is invented.
 */
import { describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1280, height: 900 });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.customElements = win.customElements;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = (win as unknown as Record<string, unknown>)[key];
}

// The folds animate through `motion`; happy-dom's Web Animations reject on cancel. Tests skip the animation.
const { MotionGlobalConfig } = await import('motion/react');
MotionGlobalConfig.skipAnimations = true;

const stopCalls: Array<[string, string]> = [];
const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  stopProjectSession: async (projectId: string, sessionId: string) => {
    stopCalls.push([projectId, sessionId]);
    return { ok: true, session_id: sessionId, status: 'stopped' };
  },
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { TooltipProvider } = await import('../../../primitives/tooltip');
const { IntlTestProvider } = await import('../../../test-utils/intl');
const { SessionIdsProvider } = await import('../../../providers/session-ids');
const { ToolRunningContext } = await import('../shared/infrastructure');
const { WorkflowTool } = await import('./workflow-tool');
const { toolCallBlock } = realSdk;

type Agent = Record<string, unknown>;

function call(metadata: Record<string, unknown>, state: Record<string, unknown> = { status: 'running' }) {
  return toolCallBlock({
    type: 'tool',
    tool: 'workflow',
    callID: 'call-1',
    state: { input: { description: 'Market check' }, metadata, ...state },
  } as never);
}

function runDoc(agents: Agent[], extra: Record<string, unknown> = {}) {
  return { runId: 'run-1', title: 'Market check', status: 'running', phases: [], agents, startedAt: 1_790_000_000_000, ...extra };
}

async function mount(metadata: Record<string, unknown>, state?: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <IntlTestProvider locale="en">
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <SessionIdsProvider projectId="proj_1">
              <ToolRunningContext.Provider value>
                <WorkflowTool call={call(metadata, state)} />
              </ToolRunningContext.Provider>
            </SessionIdsProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </IntlTestProvider>,
    );
  });
  return {
    host: host as unknown as HTMLElement,
    unmount: () => act(async () => root.unmount()),
  };
}

const mouse = (el: Element, type: string) =>
  el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
const click = (el: Element) => act(async () => void mouse(el, 'click'));
const key = (el: Element, k: string) =>
  act(async () => void el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }) as unknown as Event));
const rowLabels = (host: HTMLElement) =>
  [...host.querySelectorAll('button[aria-label^="Open "]')].map((b) => b.getAttribute('aria-label')!.slice(5));
const byText = (host: HTMLElement, selector: string, text: string) =>
  [...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(text))!;

const tenAgents: Agent[] = Array.from({ length: 10 }, (_, i) => ({
  id: `a${i + 1}`,
  label: `Market ${i + 1}`,
  status: i < 6 ? 'done' : i < 9 ? 'running' : 'failed',
  sessionId: `ses_m${i + 1}`,
}));

describe('WorkflowTool — the status filter', () => {
  test('a filter tab narrows the rows to its status; `f` cycles the filter from a row, as in Claude Code', async () => {
    const { host, unmount } = await mount(runDoc(tenAgents));
    expect(rowLabels(host)).toHaveLength(10);

    // Radix Tabs activates a tab on mousedown.
    await act(async () => void mouse(byText(host, '[role="tab"]', 'Running'), 'mousedown'));
    expect(rowLabels(host)).toEqual(['Market 7', 'Market 8', 'Market 9']);

    // From a row, `f` moves to the next filter: Failed.
    await key(host.querySelector('button[aria-label="Open Market 7"]')!, 'f');
    expect(rowLabels(host)).toEqual(['Market 10']);
    expect(byText(host, '[role="tab"]', 'Failed').getAttribute('aria-selected')).toBe('true');

    // Done, then back to All.
    await key(host.querySelector('button[aria-label="Open Market 10"]')!, 'f');
    expect(rowLabels(host)).toHaveLength(6);
    await key(host.querySelector('button[aria-label="Open Market 1"]')!, 'f');
    expect(rowLabels(host)).toHaveLength(10);
    await unmount();
  });

  test('a filter with no match says so in one line', async () => {
    const { host, unmount } = await mount(runDoc(tenAgents.map((a) => ({ ...a, status: 'done' }))));
    await act(async () => void mouse(byText(host, '[role="tab"]', 'Failed'), 'mousedown'));
    expect(rowLabels(host)).toEqual([]);
    expect(host.textContent).toContain('No agent failed.');
    await unmount();
  });
});

describe('WorkflowTool — keyboard and folds', () => {
  test('↓ and ↑ move focus between rows', async () => {
    const { host, unmount } = await mount(runDoc(tenAgents.slice(0, 3)));
    const first = host.querySelector<HTMLElement>('button[aria-label="Open Market 1"]')!;
    first.focus();
    await key(first, 'ArrowDown');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open Market 2');
    await key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open Market 1');
    await unmount();
  });

  test('a phase header folds its agents away and opens them again', async () => {
    const agents = [
      { id: 'a1', label: 'Read docs', phase: 'Research', status: 'done', sessionId: 'ses_1' },
      { id: 'a2', label: 'Draft', phase: 'Write', status: 'running', sessionId: 'ses_2' },
    ];
    const { host, unmount } = await mount(
      runDoc(agents, { phases: [{ title: 'Research', status: 'done' }, { title: 'Write', status: 'running' }] }),
    );
    const research = byText(host, 'button[aria-expanded]', 'Research');
    expect(research.getAttribute('aria-expanded')).toBe('true');
    await click(research);
    expect(rowLabels(host)).toEqual(['Draft']);
    await click(research);
    expect(rowLabels(host)).toEqual(['Read docs', 'Draft']);
    await unmount();
  });

  test('"Show all" lists every agent of a long phase', async () => {
    const agents = Array.from({ length: 30 }, (_, i) => ({ id: `a${i + 1}`, label: `File ${i + 1}`, status: 'done', sessionId: `ses_f${i + 1}` }));
    const { host, unmount } = await mount(runDoc(agents));
    expect(rowLabels(host)).toHaveLength(20);
    await click(byText(host, 'button', 'Show all 30'));
    expect(rowLabels(host)).toHaveLength(30);
    await unmount();
  });

  test('a structured answer opens to its formatted JSON', async () => {
    const agents = [{ id: 'a1', label: 'List files', status: 'done', sessionId: 'ses_1', structured: true, summary: '{"files":["a.ts"],"total":1}' }];
    const { host, unmount } = await mount(runDoc(agents));
    const toggle = byText(host, 'button[aria-expanded]', 'JSON · 2 keys');
    expect(host.querySelector('pre')).toBeNull();
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('pre')?.textContent).toBe('{\n  "files": [\n    "a.ts"\n  ],\n  "total": 1\n}');
    await unmount();
  });

  test('the result fold opens onto the script\'s result as Markdown, without the raw tags', async () => {
    const agents = [{ id: 'a1', label: 'Read docs', status: 'done', sessionId: 'ses_1' }];
    const output = '<workflow_result>\n**Three** competitors cut prices.\n</workflow_result>\nagents: 1 (1 done)';
    const { host, unmount } = await mount(runDoc(agents, { status: 'done', endedAt: 1_790_000_060_000 }), { status: 'completed', output });
    // A finished run stays closed: open the card, then the fold.
    await click(host.querySelector('[data-component="tool-trigger"]')!);
    const fold = byText(host, '[role="button"][aria-expanded]', 'Result');
    await click(fold);
    expect(host.querySelector('strong')?.textContent).toBe('Three');
    expect(host.textContent).toContain('competitors cut prices.');
    expect(host.textContent).not.toContain('workflow_result');
    await unmount();
  });
});

describe('WorkflowTool — Stop', () => {
  test('Stop on a running row stops that agent\'s session through the SDK and shows the stop in flight', async () => {
    stopCalls.length = 0;
    const { host, unmount } = await mount(runDoc(tenAgents.slice(5, 8)));
    expect(host.querySelector('button[aria-label="Stop Market 6"]')).toBeNull();
    const stop = host.querySelector('button[aria-label="Stop Market 7"]')!;
    await click(stop);
    expect(stopCalls).toEqual([['proj_1', 'ses_m7']]);
    // Until the run reports the agent stopped, its slot holds a spinner, not a second Stop.
    expect(host.querySelector('button[aria-label="Stop Market 7"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Stop Market 8"]')).not.toBeNull();
    await unmount();
  });
});
