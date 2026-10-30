/**
 * The capture thread (`captureInThread` in `session-transcript-capture.ts`): one journal-less
 * capture too large for the API's event loop, run end to end (box read, conversion, write) on
 * this Worker's own heap, event loop and DB pool. Answers the capture's result once the capture
 * and every capture it queued have settled; the caller then ends the thread.
 */
import { captureJournallessSessionLog, transcriptCapturesSettledForTests, type CaptureOptions } from './session-transcript-capture';

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ sessionId: string; options: CaptureOptions }>) => {
  const { sessionId, options } = event.data;
  const result = await captureJournallessSessionLog(sessionId, undefined, { ...options, inThread: true });
  await transcriptCapturesSettledForTests(sessionId);
  self.postMessage(result);
};
