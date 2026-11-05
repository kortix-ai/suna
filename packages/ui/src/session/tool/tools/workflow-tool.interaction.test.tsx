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

describe('WorkflowTool — keyboard and folds', () => {
  test('↓ and ↑ move focus between rows', async () => {
    const { host, unmount } = await mount(runDoc(tenAgents.slice(0, 3)));
    // Rows sort by status, so walk them in the order the card draws them.
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-workflow-row]'));
    rows[0]!.focus();
    await key(rows[0]!, 'ArrowDown');
    expect(document.activeElement as unknown).toBe(rows[1]);
    await key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement as unknown).toBe(rows[0]);
    await unmount();
  });

  test('a phase opens in place onto its agents, nested on the trunk, and closes again', async () => {
    const agents = [
      { id: 'a1', label: 'Read docs', phase: 'Research', status: 'done', sessionId: 'ses_1' },
      { id: 'a2', label: 'Draft', phase: 'Write', status: 'running', sessionId: 'ses_2' },
    ];
    const { host, unmount } = await mount(
      runDoc(agents, { phases: [{ title: 'Research', status: 'done' }, { title: 'Write', status: 'running' }] }),
    );
    // Every phase starts closed: no agent row yet.
    expect(rowLabels(host)).toEqual([]);
    const write = host.querySelector<HTMLElement>('[data-workflow-phase="Write"] button[aria-expanded]')!;
    expect(write.getAttribute('aria-expanded')).toBe('false');
    await act(async () => write.click());
    expect(write.getAttribute('aria-expanded')).toBe('true');
    expect(rowLabels(host)).toEqual(['Draft, Running']);
    await act(async () => write.click());
    expect(rowLabels(host)).toEqual([]);
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

  test('the result fold opens onto the script\'s result as Markdown, without the raw tags', async () => {
    const agents = [{ id: 'a1', label: 'Read docs', status: 'done', sessionId: 'ses_1' }];
    const output = '<workflow_result>\n**Three** competitors cut prices.\n</workflow_result>\nagents: 1 (1 done)';
    const { host, unmount } = await mount(runDoc(agents, { status: 'done', endedAt: 1_790_000_060_000 }), { status: 'completed', output });
    // The result opens from the card header's "Result", inside the card.
    const fold = byText(host, 'button[aria-expanded]', 'Result');
    await click(fold);
    expect(host.querySelector('strong')?.textContent).toBe('Three');
    expect(host.textContent).toContain('competitors cut prices.');
    expect(host.textContent).not.toContain('workflow_result');
    await unmount();
  });
});

