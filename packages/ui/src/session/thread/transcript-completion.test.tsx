import { Window } from 'happy-dom';
import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurns, type SessionLogMessage } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '../../primitives/tooltip';
import { Disclosure } from '../../primitives/disclosure';
import { IntlTestProvider } from '../../test-utils/intl';
import '../tool/tools/register';
import { SessionTurn } from './transcript';

const browser = new Window();
Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
Object.defineProperty(globalThis, 'document', { value: browser.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let mounted: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => mounted?.unmount()); });
const client = new QueryClient();
function render(working: boolean) {
  const message: SessionLogMessage = {
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: 'reply', thread_id: 'synthetic', seq: 2,
    role: 'assistant', kind: 'turn', status: working ? 'streaming' : 'complete', in_context: true,
    model: null, usage: null, finish: null, error: null, created_at: '2026-01-01T00:00:00Z',
    completed_at: working ? null : '2026-01-01T00:00:30Z',
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' },
    blocks: ['first', 'second'].map(id => ({
      type: 'tool_call', id, call_id: id, name: 'bash', kind: 'other', input: { command: 'printf synthetic' }, status: 'complete',
      result: { content: [{ type: 'text', text: 'synthetic output' }], is_error: false },
      started_at: '2026-01-01T00:00:01Z', ended_at: '2026-01-01T00:00:20Z',
    })),
  };
  const turn = sessionLogTurns({ schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'synthetic',
    parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages: [{ ...message, message_id: 'prompt', role: 'user', status: 'complete', blocks: [{ type: 'text', id: 'prompt-text', text: 'Run two synthetic steps' }] }, { ...message, reply_to: 'prompt' }] })[0];
  if (!turn) throw new Error('Missing synthetic turn');
  return <IntlTestProvider locale="en" onError={() => {}}><QueryClientProvider client={client}><TooltipProvider>
    <SessionTurn turn={turn} turnOutcome={{}} sessionId="synthetic" sessionStatus={undefined} isLast ownsPlan={false}
      permissions={[]} questions={[]} sessionWorking={working} isWorkingTurn={working}
      suppressBusyIndicator={false} awaitingUser={false} pending={false} isFirstTurn
      onPermissionReply={async () => {}} onRewind={() => {}} rewindDisabled />
  </TooltipProvider></QueryClientProvider></IntlTestProvider>;
}

const findBurst = () => mounted!.root.find(node => typeof node.type === 'function' && node.type.name === 'ActivityBurstImpl');
const workRow = () => mounted!.root.find(node => node.type === 'button' && node.props['aria-expanded'] !== undefined && String(node.props.children?.[0]?.props?.children ?? '').startsWith('Worked'));
/** The keyed wrapper around a segment: its `hidden` is the fold. */
const wrapperOf = (node: ReturnType<typeof findBurst>) => {
  let current = node.parent;
  while (current && !(current.type === 'div' && 'hidden' in current.props)) current = current.parent;
  if (!current) throw new Error('Missing segment wrapper');
  return current;
};

test('an untouched live turn folds closed at completion, without a remount', async () => {
  await act(async () => { mounted = create(render(true)); });
  const burst = findBurst();
  expect(wrapperOf(burst).props.hidden).toBe(false);
  await act(async () => mounted?.update(render(false)));
  expect(findBurst()).toBe(burst);
  expect(workRow().props['aria-expanded']).toBe(false);
  expect(wrapperOf(burst).props.hidden).toBe(true);
  // The burst closed again when the turn stopped: an opened row reads as one line per burst.
  expect(burst.findAllByType(Disclosure)[0].props.open).toBe(false);
});

test('a turn the reader touched while live settles open, its tree as the reader left it', async () => {
  await act(async () => { mounted = create(render(true)); });
  const burst = findBurst();
  await act(async () => burst.findAllByType(Disclosure)[0].props.onOpenChange(true));
  await act(async () => mounted?.update(render(false)));
  expect(findBurst()).toBe(burst);
  expect(workRow().props['aria-expanded']).toBe(true);
  expect(wrapperOf(burst).props.hidden).toBe(false);
  expect(burst.findAllByType(Disclosure)[0].props.open).toBe(true);
});

test('a manually collapsed burst stays collapsed after completion', async () => {
  await act(async () => { mounted = create(render(true)); });
  const burst = findBurst();
  await act(async () => burst.findAllByType(Disclosure)[0].props.onOpenChange(false));
  await act(async () => mounted?.update(render(false)));
  expect(findBurst()).toBe(burst);
  expect(burst.findAllByType(Disclosure)[0].props.open).toBe(false);
});

test('reloaded history paints the closed row and mounts its work on the first open', async () => {
  await act(async () => { mounted = create(render(false)); });
  expect(workRow().props['aria-expanded']).toBe(false);
  expect(mounted!.root.findAll(node => typeof node.type === 'function' && node.type.name === 'ActivityBurstImpl')).toHaveLength(0);
  await act(async () => workRow().props.onClick());
  expect(workRow().props['aria-expanded']).toBe(true);
  expect(wrapperOf(findBurst()).props.hidden).toBe(false);
  await act(async () => workRow().props.onClick());
  expect(wrapperOf(findBurst()).props.hidden).toBe(true);
});
