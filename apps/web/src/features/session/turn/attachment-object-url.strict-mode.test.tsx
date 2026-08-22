import { freezeClock, restoreClock } from '../timeline/__fixtures__/clock';
import { installDom, uninstallDom } from '../timeline/__fixtures__/dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { MessageWithParts, Part, Turn } from '@/ui';
import { groupMessagesIntoTurns } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';

import { buildChatRows } from '../timeline/build-chat-rows';
import { deriveAnsweredQuestionIds } from '../timeline/project-rows';
import {
  SessionTimelineList,
  type SessionTimelineListProps,
} from '../timeline/session-timeline-list';
import {
  __testing,
  releaseAttachmentObjectUrls,
  retainAttachmentObjectUrls,
} from './attachment-object-url';
import { stabilizeTurns } from './stable-turns';

/**
 * The object-URL lifetime under React STRICT MODE — Next's dev default
 * (`apps/web/next.config.ts` sets nothing, so `reactStrictMode` is on), which
 * runs every effect mount → simulated unmount → mount again in ONE commit.
 *
 * `SessionChat` retains its session's object URLs in an effect and releases
 * them in the cleanup. Under strict mode that is retain → release → retain
 * inside one commit; a release that revoked synchronously pulled every
 * `blob:` URL from under the `<img src>` elements committed in that same
 * pass, and dropped the cache entries, so the attachment tiles of a session
 * rendered broken until their rows happened to remount. The release is
 * therefore DEFERRED (a microtask), and a retain of the same session before
 * it fires cancels it — the cache entry and the URL live through the cycle.
 * The last release of a session (no retain following it) still revokes.
 */

// A 1×1 PNG — a REAL base64 payload, so the decode path is the composer's.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PNG_B64}`;
const SESSION = 'ses_strict';
const PART_ID = 'prt_shot';

type AnyPart = Record<string, unknown>;
const part = (messageID: string, id: string, rest: AnyPart): Part =>
  ({ id, messageID, sessionID: SESSION, ...rest }) as unknown as Part;

const messages: MessageWithParts[] = [
  {
    info: { id: 'u1', role: 'user', sessionID: SESSION, time: { created: 1000 } },
    parts: [
      part('u1', 'u1t', { type: 'text', text: 'look at this' }),
      part('u1', PART_ID, {
        type: 'file',
        mime: 'image/png',
        filename: 'shot.png',
        url: DATA_URL,
      }),
    ],
  },
  {
    info: {
      id: 'a1',
      role: 'assistant',
      parentID: 'u1',
      sessionID: SESSION,
      time: { created: 1010, completed: 1020 },
    },
    parts: [part('a1', 'a1t', { type: 'text', text: 'a picture' })],
  },
] as unknown as MessageWithParts[];

const noop = () => {};
const noopReply = async () => {};
const client = new QueryClient();
const INTL_MESSAGES = {};
const onIntlError = () => {};

/** Let React commit and its passive effects (and the strict-mode re-invoke)
 *  run, then every queued microtask and zero-delay timer. */
const flush = () => new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve, 20), 20));

function listProps(): SessionTimelineListProps {
  const turns: Turn[] = stabilizeTurns(groupMessagesIntoTurns(messages), []);
  const turnsById = new Map<string, Turn>(turns.map((t) => [t.userMessage.info.id, t]));
  const turnRenderKeys = new Map<string, string>(
    turns.map((t) => [t.userMessage.info.id, t.userMessage.info.id]),
  );
  const rows = buildChatRows({
    messages,
    activeUserMessageID: undefined,
    status: 'idle',
    standaloneCallIds: new Set(),
    answeredQuestionIds: deriveAnsweredQuestionIds(turns, [], SESSION),
    prev: undefined,
  });
  return {
    rows,
    turnsById,
    turnRenderKeys,
    pendingTurnIds: new Set(),
    interruptedTurnIds: new Set(),
    sessionWorking: false,
    workingTurnId: null,
    planAnchorId: null,
    inboxRowsByMessageId: new Map(),
    queueHeld: false,
    onQueueRemove: noop,
    onQueueSendNow: noop,
    onQueueRetry: noop,
    sessionId: SESSION,
    sessionStatus: { type: 'idle' } as SessionTimelineListProps['sessionStatus'],
    permissions: [],
    questions: [],
    agentNames: [],
    providers: undefined,
    commandMessages: undefined,
    commands: [],
    disableToolNavigation: false,
    onPermissionReply: noopReply,
    onRewind: noop,
    rewindDisabled: true,
  };
}

/** `SessionChat`'s retain / release effect, verbatim, around the list. */
function Holder({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  useEffect(() => {
    retainAttachmentObjectUrls(sessionId);
    return () => releaseAttachmentObjectUrls(sessionId);
  }, [sessionId]);
  return <>{children}</>;
}

function Chat() {
  return (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={INTL_MESSAGES} onError={onIntlError}>
        <TooltipProvider>
          <Holder sessionId={SESSION}>
            <SessionTimelineList {...listProps()} />
          </Holder>
        </TooltipProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

/** `StrictMode` as the ROOT element — where Next's `reactStrictMode` puts it.
 *  (React 19 double-invokes effects for a strict ROOT on mount; a `StrictMode`
 *  returned from a non-strict root component does not re-invoke them.) */
const chat = (strict: boolean) =>
  strict ? (
    <StrictMode>
      <Chat />
    </StrictMode>
  ) : (
    <Chat />
  );

let container: HTMLElement;
let root: Root;
let created: string[];
let revoked: string[];

beforeAll(() => {
  installDom();
  freezeClock();
});
afterAll(() => {
  restoreClock();
  uninstallDom();
});
beforeEach(() => {
  __testing.reset();
  created = [];
  revoked = [];
  __testing.spyCreate((url) => created.push(url));
  __testing.spyRevoke((url) => revoked.push(url));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  root.unmount();
  await flush();
  container.remove();
  __testing.reset();
});

const committedImgSrc = (): string => {
  const img = container.querySelector<HTMLImageElement>('img[alt="shot.png"]');
  if (!img) throw new Error('attachment <img> not rendered');
  return img.getAttribute('src') ?? '';
};

describe('attachment object URLs under React StrictMode', () => {
  test('the committed <img src> survives the mount → unmount → mount effect cycle', async () => {
    root.render(chat(true));
    await flush();

    const src = committedImgSrc();
    expect(src.startsWith('blob:')).toBe(true);
    // The URL the tile shows is alive: never revoked, its entry still cached.
    expect(revoked).not.toContain(src);
    expect(revoked).toEqual([]);
    expect(__testing.blobFor(PART_ID)).toBeDefined();
    expect(__testing.size()).toBe(1);
    // And it was decoded ONCE — the strict re-render did not mint a second URL.
    expect(created).toEqual([src]);
  });

  test('the LAST release (a real unmount) still revokes, once nothing re-retains it', async () => {
    root.render(chat(true));
    await flush();
    const src = committedImgSrc();
    expect(revoked).toEqual([]);

    root.unmount();
    await flush();
    expect(revoked).toEqual([src]);
    expect(__testing.size()).toBe(0);
  });

  test('without StrictMode: no revoke while mounted, one revoke after unmount', async () => {
    root.render(chat(false));
    await flush();
    const src = committedImgSrc();
    expect(src.startsWith('blob:')).toBe(true);
    expect(revoked).toEqual([]);
    expect(__testing.size()).toBe(1);

    root.unmount();
    await flush();
    expect(revoked).toEqual([src]);
    expect(__testing.size()).toBe(0);
  });
});
