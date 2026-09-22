/**
 * Mobile's SSE wire, handed to `@kortix/sdk` once at startup.
 *
 * `setEventStreamTransport` is the seam that lets this app mount the SDK's
 * `useSession` at all: everything else about live streaming — reconnect,
 * backoff, the heartbeat watchdog, coalescing, the give-up/park state — comes
 * from `openEventStream` and is now shared with apps/web instead of being
 * reimplemented here.
 *
 * Kept deliberately tiny. The testable half is `event-source-stream.ts`; this
 * file only binds the two things that cannot exist in a test: the real
 * `react-native-sse` EventSource, and the live Supabase token.
 */

import EventSource from 'react-native-sse';
import type { EventStreamTransport } from '@kortix/sdk';

import { getAuthToken } from '@/api/config';
import { openEventSourceStream } from './event-source-stream';

/**
 * Opens one authenticated SSE connection to a session runtime.
 *
 * Rejecting is how a failed attempt is reported; the SDK owns the retry. The
 * token is read per attempt rather than captured once, so a reconnect after a
 * refresh carries the new credential.
 */
export const reactNativeEventStreamTransport: EventStreamTransport = async ({ url, signal }) => {
  const token = await getAuthToken();
  // Awaiting the token is a real gap — a `close()` during it must not leave a
  // connection behind, so re-check before opening.
  if (signal.aborted) throw new Error('SSE attempt aborted before connect');

  return {
    stream: openEventSourceStream({
      url,
      signal,
      createEventSource: (eventSourceUrl) =>
        new EventSource(eventSourceUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
    }),
  };
};
