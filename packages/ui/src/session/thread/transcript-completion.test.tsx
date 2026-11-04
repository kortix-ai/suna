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

test('completion preserves an expanded tool tree and its component identity', async () => {
  await act(async () => { mounted = create(render(true)); });
  if (!mounted) throw new Error('Missing renderer');
  const burst = mounted.root.find(node => typeof node.type === 'function' && node.type.name === 'ActivityBurstImpl');
  const disclosure = burst.findAllByType(Disclosure)[0];
  await act(async () => disclosure.props.onOpenChange(true));
  expect(disclosure.props.open).toBe(true);
  await act(async () => mounted?.update(render(false)));
  expect(mounted.root.find(node => typeof node.type === 'function' && node.type.name === 'ActivityBurstImpl')).toBe(burst);
  expect(burst.findAllByType(Disclosure)[0].props.open).toBe(true);
});

test('completion preserves a manually collapsed tool tree', async () => {
  await act(async () => { mounted = create(render(true)); });
  if (!mounted) throw new Error('Missing renderer');
  const burst = mounted.root.find(node => typeof node.type === 'function' && node.type.name === 'ActivityBurstImpl');
  await act(async () => burst.findAllByType(Disclosure)[0].props.onOpenChange(true));
  await act(async () => burst.findAllByType(Disclosure)[0].props.onOpenChange(false));
  await act(async () => mounted?.update(render(false)));
  expect(mounted.root.find(node => typeof node.type === 'function' && node.type.name === 'ActivityBurstImpl')).toBe(burst);
  expect(burst.findAllByType(Disclosure)[0].props.open).toBe(false);
});

test('previously completed history retains its compact Worked disclosure', async () => {
  await act(async () => { mounted = create(render(false)); });
  if (!mounted) throw new Error('Missing renderer');
  const work = mounted.root.find(node => typeof node.type === 'function' && node.type.name === 'TurnWorkAccordion');
  expect(work.findByType(Disclosure).findAll(node => node.props['data-state'] === 'closed').length).toBeGreaterThan(0);
});

test('completion keeps the live parent open around expanded command details', async () => {
  await act(async () => { mounted = create(render(true)); });
  if (!mounted) throw new Error('Missing renderer');
  const burst = mounted.root.find(node => typeof node.type === 'function' && node.type.name === 'ActivityBurstImpl');
  expect(burst.findAllByType(Disclosure)[0].props.open).toBe(true);
  await act(async () => mounted?.update(render(false)));
  expect(burst.findAllByType(Disclosure)[0].props.open).toBe(true);
});
