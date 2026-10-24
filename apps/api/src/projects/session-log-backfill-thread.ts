/**
 * The backfill's conversion thread (P3.4, `convertInThread` in `session-log-backfill.ts`): one
 * session over the capture's size cap, converted by `convertOne` with the cap off, on this
 * Worker's own heap, event loop and DB pool. Answers the session's counts; the leader then ends
 * the thread.
 */
import { convertOne, mergeOne, zero, type BackfillMode } from './session-log-backfill';
import { mergeMirrorIntoLog, writeSessionLogFromMirror } from './session-log-capture';

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ sessionId: string; mode: BackfillMode; merge?: boolean }>) => {
  const { sessionId, mode, merge } = event.data;
  const counts = zero();
  if (merge) await mergeOne(sessionId, (id) => mergeMirrorIntoLog(id, { uncapped: true }), counts);
  else await convertOne(sessionId, mode, (id, options) => writeSessionLogFromMirror(id, { ...options, uncapped: true }), counts);
  self.postMessage(counts);
};
