import './__fixtures__/clock';
import { uninstallDom } from './__fixtures__/dom';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { MessageWithParts, Part, Turn } from '@/ui';
import { groupMessagesIntoTurns } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';

import type { TimelineRow } from '@kortix/sdk';
import { stabilizeTurns } from '../turn/stable-turns';
import { buildChatRows } from './build-chat-rows';
import { deriveAnsweredQuestionIds } from './project-rows';
import { SessionTimelineList, type SessionTimelineListProps } from './session-timeline-list';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type AnyPart = Record<string, unknown>;
const part = (messageID: string, id: string, rest: AnyPart): Part =>
  ({ id, messageID, sessionID: 'ses', ...rest }) as unknown as Part;
const text = (m: string, id: string, body: string) => part(m, id, { type: 'text', text: body });
const tool = (m: string, id: string, name: string, state: AnyPart) =>
  part(m, id, { type: 'tool', tool: name, callID: `call_${id}`, state });

const settled: MessageWithParts[] = [
  {
    info: { id: 'u1', role: 'user', sessionID: 'ses', time: { created: 1000 } },
    parts: [text('u1', 'u1t', 'first prompt')],
  },
  {
    info: {
      id: 'a1',
      role: 'assistant',
      parentID: 'u1',
      sessionID: 'ses',
      time: { created: 1010, completed: 1020 },
    },
    parts: [text('a1', 'a1t', 'first answer')],
  },
  {
    info: { id: 'u2', role: 'user', sessionID: 'ses', time: { created: 2000 } },
    parts: [text('u2', 'u2t', 'second prompt')],
  },
] as unknown as MessageWithParts[];

const streaming = (parts: Part[], completed?: number): MessageWithParts =>
  ({
    info: {
      id: 'a2',
      role: 'assistant',
      parentID: 'u2',
      sessionID: 'ses',
      time: completed ? { created: 2010, completed } : { created: 2010 },
    },
    parts,
  }) as unknown as MessageWithParts;

const readTool = tool('a2', 'a2read', 'read', {
  status: 'completed',
  time: { start: 1, end: 2 },
  input: { filePath: '/x.ts' },
  output: 'x',
});

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const noop = () => {};
const noopReply = async () => {};

/** Let React commit: its scheduler runs on macrotasks under happy-dom. Two
 *  ticks of 20ms cover the render, the passive effects and any re-render
 *  those effects queue — and stay well under the 1s tickers. */
const flush = () => new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve, 20), 20));

/** Host facts `SessionChat` keeps identity-stable across frames (`useMemo`,
 *  `useCallback`): the harness does too, or every memo below fails for a
 *  reason that has nothing to do with the rows. */
const STABLE = {
  pendingTurnIds: new Set<string>(),
  interruptedTurnIds: new Set<string>(),
  inboxRowsByMessageId: new Map(),
  permissions: [],
  questions: [],
  agentNames: [],
  commands: [],
  busy: { type: 'busy' } as SessionTimelineListProps['sessionStatus'],
  idle: { type: 'idle' } as SessionTimelineListProps['sessionStatus'],
};

class Harness {
  root: Root;
  container: HTMLElement;
  renders: string[] = [];
  rows: TimelineRow[] | undefined;
  turns: Turn[] = [];
  turnRenderKeys = new Map<string, string>();
  /** ONE function for the life of the harness — a fresh arrow per frame would
   *  defeat every row memo by itself. */
  onRowRender = (key: string): void => {
    this.renders.push(key);
  };

  constructor() {
    this.container = document.createElement('div');
    document.body.appendChild(this.container);
    this.root = createRoot(this.container);
  }

  props(messages: MessageWithParts[], working: boolean): SessionTimelineListProps {
    this.turns = stabilizeTurns(groupMessagesIntoTurns(messages), this.turns);
    const turnsById = new Map<string, Turn>(this.turns.map((t) => [t.userMessage.info.id, t]));
    for (const t of this.turns) {
      const id = t.userMessage.info.id;
      if (!this.turnRenderKeys.has(id)) this.turnRenderKeys.set(id, id);
    }
    this.rows = buildChatRows({
      messages,
      activeUserMessageID: 'u2',
      status: working ? 'busy' : 'idle',
      standaloneCallIds: new Set(),
      answeredQuestionIds: deriveAnsweredQuestionIds(this.turns, [], 'ses'),
      prev: this.rows,
    });
    return {
      rows: this.rows,
      turnsById,
      turnRenderKeys: this.turnRenderKeys,
      pendingTurnIds: STABLE.pendingTurnIds,
      interruptedTurnIds: STABLE.interruptedTurnIds,
      sessionWorking: working,
      workingTurnId: 'u2',
      planAnchorId: null,
      inboxRowsByMessageId: STABLE.inboxRowsByMessageId,
      queueHeld: false,
      onQueueRemove: noop,
      onQueueSendNow: noop,
      onQueueRetry: noop,
      sessionId: 'ses',
      sessionStatus: working ? STABLE.busy : STABLE.idle,
      permissions: STABLE.permissions,
      questions: STABLE.questions,
      agentNames: STABLE.agentNames,
      providers: undefined,
      commandMessages: undefined,
      commands: STABLE.commands,
      disableToolNavigation: false,
      onPermissionReply: noopReply,
      onRewind: noop,
      rewindDisabled: true,
      onRowRender: this.onRowRender,
    };
  }

  async render(messages: MessageWithParts[], working: boolean): Promise<string[]> {
    const props = this.props(messages, working);
    this.renders = [];
    this.root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={INTL_MESSAGES} onError={onIntlError}>
          <TooltipProvider>
            <SessionTimelineList {...props} />
          </TooltipProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await flush();
    return [...this.renders];
  }

  async unmount(): Promise<void> {
    this.root.unmount();
    await flush();
    this.container.remove();
  }
}

const client = new QueryClient();
/** The app mounts ONE intl provider; a fresh `messages` / `onError` per frame
 *  would re-render every `useTranslations` consumer (the tail rows). */
const INTL_MESSAGES = {};
const onIntlError = () => {};

let harness: Harness;
beforeEach(() => {
  harness = new Harness();
});
afterEach(async () => {
  await harness.unmount();
});
// Every later test file in this process gets the globals it expects.
afterAll(() => uninstallDom());

const byPrefix = (keys: string[], prefix: string) => keys.filter((k) => k.startsWith(prefix));

// ---------------------------------------------------------------------------
// T7
// ---------------------------------------------------------------------------

describe('one part delta re-renders one row', () => {
  test('five deltas into one text part: one AssistantPartRow per delta, no UserMessageRow', async () => {
    let body = 'Strea';
    const first = await harness.render(
      [...settled, streaming([readTool, text('a2', 'a2t', body)])],
      true,
    );
    // Mount renders everything once.
    expect(byPrefix(first, 'user:').sort()).toEqual(['user:u1', 'user:u2']);
    expect(byPrefix(first, 'part:').length).toBe(3); // a1 response, a2 burst, a2 text-step

    for (let i = 0; i < 5; i++) {
      body += 'm';
      const rendered = await harness.render(
        [...settled, streaming([readTool, text('a2', 'a2t', body)])],
        true,
      );
      const parts = byPrefix(rendered, 'part:');
      expect(parts.filter((k) => !k.includes(':a2t'))).toEqual([]);
      expect(parts).toHaveLength(1);
      expect(byPrefix(rendered, 'user:')).toEqual([]);
      // The tail of any OTHER turn never runs.
      expect(byPrefix(rendered, 'tail:').filter((k) => k !== 'tail:u2')).toEqual([]);
    }
  });

  test('appending a part renders only the new row', async () => {
    // The SAME text part object on both frames — only the appended part is new.
    const done = text('a2', 'a2t', 'Done.');
    await harness.render([...settled, streaming([readTool, done])], true);
    const bash = tool('a2', 'a2bash', 'bash', {
      status: 'running',
      time: { start: 3 },
      input: { command: 'ls' },
    });
    const rendered = await harness.render([...settled, streaming([readTool, done, bash])], true);
    const parts = byPrefix(rendered, 'part:');
    expect(parts.filter((k) => !k.includes(':a2bash'))).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(byPrefix(rendered, 'user:')).toEqual([]);
    expect(byPrefix(rendered, 'tail:').filter((k) => k !== 'tail:u2')).toEqual([]);
  });

  test('settling the turn re-renders only the working turn', async () => {
    const parts = [readTool, text('a2', 'a2t', 'Done.')];
    await harness.render([...settled, streaming(parts)], true);
    const rendered = await harness.render([...settled, streaming(parts, 2500)], false);
    // Every re-render belongs to u2: its rows take `working`, its tail takes the footer.
    expect(rendered.filter((k) => !(k.endsWith(':u2') || k.includes(':a2')))).toEqual([]);
    expect(byPrefix(rendered, 'user:')).toEqual([]);
    expect(rendered).toContain('tail:u2');
    expect(rendered.some((k) => k.startsWith('part:') && k.includes('a1'))).toBe(false);
  });
});
