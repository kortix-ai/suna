import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AssistantMessage, TextPart, ToolPart, UserMessage } from '@opencode-ai/sdk/v2/client';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useSyncStore } from '../browser/stores/sync-store';
import { useRuntimeMessages, useSession, useSessionMessages } from './opencode';

/**
 * Render cost of `useSession` while a turn streams.
 *
 * A streaming turn applies one `message.part.delta` per ~16 ms batch. Every
 * component that calls `useSession` with the default options re-renders on
 * each one, because the hook returns the live transcript. A host that only
 * needs lifecycle (boot phase, status, actions) opts out with
 * `subscribeMessages: false`, and reads the transcript where it renders it
 * with `useSessionMessages`.
 *
 * No network runs here: `enabled: false` gates `/start`, and the transcript is
 * seeded straight into the sync store under the pinned OpenCode id.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'proj_render';
const SESSION_ID = 'kses_render';
const OC_ID = 'ses_render';
const TRANSCRIPT_MESSAGES = 100;
const STREAMED_DELTAS = 200;

function user(id: string): UserMessage {
  return {
    id,
    sessionID: OC_ID,
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude' },
  };
}

function assistant(id: string, parentID: string): AssistantMessage {
  return {
    id,
    sessionID: OC_ID,
    role: 'assistant',
    time: { created: 1 },
    parentID,
    modelID: 'claude',
    providerID: 'anthropic',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function text(id: string, messageID: string, value: string): TextPart {
  return { id, sessionID: OC_ID, messageID, type: 'text', text: value };
}

/** 100 messages (50 turns); the last assistant message is the one that streams. */
function seedTranscript(): { streamingMessageId: string; streamingPartId: string } {
  const store = useSyncStore.getState();
  for (let turn = 0; turn < TRANSCRIPT_MESSAGES / 2; turn++) {
    const userId = `msg_${String(turn).padStart(4, "0")}_0user`;
    const assistantId = `msg_${String(turn).padStart(4, "0")}_1asst`;
    store.upsertMessage(OC_ID, user(userId));
    store.upsertPart(userId, text(`prt_${userId}`, userId, `question ${turn}`), OC_ID);
    store.upsertMessage(OC_ID, assistant(assistantId, userId));
    store.upsertPart(assistantId, text(`prt_${assistantId}`, assistantId, `answer ${turn}`), OC_ID);
  }
  const last = `msg_${String(TRANSCRIPT_MESSAGES / 2 - 1).padStart(4, "0")}_1asst`;
  return { streamingMessageId: last, streamingPartId: `prt_${last}` };
}

function streamDeltas(messageId: string, partId: string, count: number, offset = 0): void {
  for (let i = 0; i < count; i++) {
    act(() => {
      useSyncStore
        .getState()
        .applyPartDelta(OC_ID, messageId, partId, 'text', ' tok', `evt_${offset + i}`);
    });
  }
}

let renderer: ReactTestRenderer | null = null;
let queryClient: QueryClient;

function mount(node: ReactNode) {
  act(() => {
    renderer = create(createElement(QueryClientProvider, { client: queryClient }, node));
  });
}

beforeEach(() => {
  useSyncStore.getState().reset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  queryClient.clear();
});

describe('useSession render cost while a turn streams', () => {
  test('default options: the hook re-renders its host on every streamed delta (the contract hosts rely on)', () => {
    const { streamingMessageId, streamingPartId } = seedTranscript();
    let renders = 0;
    let lastLength = 0;
    function Host() {
      const session = useSession(PROJECT_ID, SESSION_ID, {
        enabled: false,
        replayStartStash: false,
        initialOpenCodeSessionId: OC_ID,
      });
      renders++;
      lastLength = session.messages.length;
      return null;
    }
    mount(createElement(Host));
    expect(lastLength).toBe(TRANSCRIPT_MESSAGES);
    const before = renders;

    streamDeltas(streamingMessageId, streamingPartId, STREAMED_DELTAS);

    expect(renders - before).toBe(STREAMED_DELTAS);
  });

  test('subscribeMessages: false — 200 deltas cause zero host renders; useSessionMessages still sees every one', () => {
    const { streamingMessageId, streamingPartId } = seedTranscript();
    let hostRenders = 0;
    let transcriptRenders = 0;
    let hostSnapshotLength = 0;
    let liveText = '';
    let liveRows: ReturnType<typeof useSessionMessages> = [];

    function Transcript({ session }: { session: Parameters<typeof useSessionMessages>[0] }) {
      const messages = useSessionMessages(session);
      transcriptRenders++;
      liveRows = messages;
      const last = messages[messages.length - 1];
      liveText = (last?.parts[0] as TextPart | undefined)?.text ?? '';
      return null;
    }
    function Host() {
      const session = useSession(PROJECT_ID, SESSION_ID, {
        enabled: false,
        replayStartStash: false,
        initialOpenCodeSessionId: OC_ID,
        subscribeMessages: false,
      });
      hostRenders++;
      hostSnapshotLength = session.messages.length;
      return createElement(Transcript, { session });
    }
    mount(createElement(Host));
    expect(hostSnapshotLength).toBe(TRANSCRIPT_MESSAGES);
    // The runtime-activity stamp is a lifecycle signal the working projection
    // reads, quantized to one write per second. Stamp it now so the burst
    // below lands inside one window and measures transcript renders only.
    act(() => useSyncStore.getState().noteSessionActivity(OC_ID));
    const hostBefore = hostRenders;
    const transcriptBefore = transcriptRenders;
    const firstRows = liveRows;

    streamDeltas(streamingMessageId, streamingPartId, STREAMED_DELTAS);

    expect(hostRenders - hostBefore).toBe(0);
    expect(transcriptRenders - transcriptBefore).toBe(STREAMED_DELTAS);
    expect(liveText).toBe(`answer ${TRANSCRIPT_MESSAGES / 2 - 1}${' tok'.repeat(STREAMED_DELTAS)}`);
    // Settled rows keep their identity; only the streaming row is new.
    for (let i = 0; i < TRANSCRIPT_MESSAGES - 1; i++) expect(liveRows[i]).toBe(firstRows[i]);
    expect(liveRows[TRANSCRIPT_MESSAGES - 1]).not.toBe(firstRows[TRANSCRIPT_MESSAGES - 1]);
  });

  test('subscribeMessages: false — the host still re-renders when the transcript SHAPE changes', () => {
    seedTranscript();
    let hostRenders = 0;
    let hostSnapshotLength = 0;
    function Host() {
      const session = useSession(PROJECT_ID, SESSION_ID, {
        enabled: false,
        replayStartStash: false,
        initialOpenCodeSessionId: OC_ID,
        subscribeMessages: false,
      });
      hostRenders++;
      hostSnapshotLength = session.messages.length;
      return null;
    }
    mount(createElement(Host));
    const before = hostRenders;

    // A new message: the count moves, so `messages.length` readers must see it.
    act(() => {
      useSyncStore.getState().upsertMessage(OC_ID, user('msg_9999_0user'));
    });
    expect(hostRenders - before).toBeGreaterThan(0);
    expect(hostSnapshotLength).toBe(TRANSCRIPT_MESSAGES + 1);

    // A tool part changing status is what the question/permission self-heal
    // pollers react to, so it re-renders the host too.
    const afterMessage = hostRenders;
    const tool = (status: 'running' | 'completed') =>
      ({
        id: 'prt_tool',
        sessionID: OC_ID,
        messageID: 'msg_0049_1asst',
        type: 'tool',
        callID: 'call_1',
        tool: 'question',
        state:
          status === 'running'
            ? { status, input: {}, time: { start: 1 } }
            : { status, input: {}, output: '', title: '', metadata: {}, time: { start: 1, end: 2 } },
      }) as unknown as ToolPart;
    act(() => {
      useSyncStore.getState().upsertPart('msg_0049_1asst', tool('running'), OC_ID);
    });
    expect(hostRenders - afterMessage).toBeGreaterThan(0);
  });

  test('useSessionMessages applies the staged rewind boundary, like useSession().messages', () => {
    seedTranscript();
    let hostLength = 0;
    let liveLength = 0;
    function Transcript({ session }: { session: Parameters<typeof useSessionMessages>[0] }) {
      liveLength = useSessionMessages(session).length;
      return null;
    }
    function Host() {
      const session = useSession(PROJECT_ID, SESSION_ID, {
        enabled: false,
        replayStartStash: false,
        initialOpenCodeSessionId: OC_ID,
      });
      hostLength = session.messages.length;
      return createElement(Transcript, { session });
    }
    mount(createElement(Host));
    act(() => {
      useSyncStore.getState().stageSessionRevert(OC_ID, 'msg_0040_0user');
    });
    expect(hostLength).toBeLessThan(TRANSCRIPT_MESSAGES);
    expect(liveLength).toBe(hostLength);
  });
});

describe('useRuntimeMessages({ ignoreStreamedText: true }) — panel consumers', () => {
  test('streamed text does not re-render; a tool part or message info change does', () => {
    const { streamingMessageId, streamingPartId } = seedTranscript();
    let renders = 0;
    let rows: ReturnType<typeof useRuntimeMessages>['data'];
    function Panel() {
      rows = useRuntimeMessages(OC_ID, { ignoreStreamedText: true }).data;
      renders++;
      return null;
    }
    mount(createElement(Panel));
    expect(rows?.length).toBe(TRANSCRIPT_MESSAGES);
    const before = renders;

    streamDeltas(streamingMessageId, streamingPartId, STREAMED_DELTAS);
    expect(renders - before).toBe(0);

    const tool = {
      id: 'prt_tool',
      sessionID: OC_ID,
      messageID: streamingMessageId,
      type: 'tool',
      callID: 'call_1',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' }, time: { start: 1 } },
    } as unknown as ToolPart;
    act(() => {
      useSyncStore.getState().upsertPart(streamingMessageId, tool, OC_ID);
    });
    expect(renders - before).toBe(1);
    const toolRow = rows?.find((row) => row.info.id === streamingMessageId);
    expect(toolRow?.parts.some((part) => part.type === 'tool')).toBe(true);
    // The row handed over with the tool change carries the text streamed so far.
    expect((toolRow?.parts.find((part) => part.type === 'text') as TextPart).text).toContain(' tok');

    act(() => {
      useSyncStore.getState().upsertMessage(OC_ID, {
        ...assistant(streamingMessageId, 'msg_0049_0user'),
        time: { created: 1, completed: 2 },
      });
    });
    expect(renders - before).toBe(2);
  });
});
