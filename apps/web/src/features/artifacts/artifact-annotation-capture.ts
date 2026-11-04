import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  type ArtifactAnnotationCaptureFailure,
  type ArtifactAnnotationFrameMessage,
  type ArtifactAnnotationHostMessage,
  type ArtifactAnnotationRect,
} from '@kortix/shared/artifact-annotations';
import type { ArtifactAnnotationScheduler } from './artifact-annotation-controller';
export type ArtifactAnnotationCaptureResult =
  | { ok: true; blob: Blob; width: number; height: number }
  | { ok: false; reason: ArtifactAnnotationCaptureFailure };
let nextRequest = 0;
const envelope = { kortix: 'annotate', v: 1 } as const;
type Start = Extract<ArtifactAnnotationFrameMessage, { type: 'capture_start' }>;
export function createArtifactAnnotationCapture(
  post: (message: ArtifactAnnotationHostMessage) => boolean,
  schedule: ArtifactAnnotationScheduler,
) {
  const send = (message: ArtifactAnnotationHostMessage) => {
    try {
      return post(message);
    } catch {
      return false;
    }
  };
  let current: {
    request: number;
    revision: number;
    resolve: (result: ArtifactAnnotationCaptureResult) => void;
    cancelTimer: () => void;
    start?: Start;
    chunks: Uint8Array[];
    bytes: number;
  } | null = null;
  const cancel = (reason: ArtifactAnnotationCaptureFailure = 'cancelled') => {
    const task = current;
    if (!task) return;
    current = null;
    task.cancelTimer();
    send({ ...envelope, type: 'cancel_capture', request: task.request });
    task.resolve({ ok: false, reason });
  };
  return {
    cancel,
    begin(
      rect: ArtifactAnnotationRect,
      revision: number,
    ): Promise<ArtifactAnnotationCaptureResult> {
      cancel();
      return new Promise((resolve) => {
        if (nextRequest >= Number.MAX_SAFE_INTEGER) {
          resolve({ ok: false, reason: 'unavailable' });
          return;
        }
        const request = ++nextRequest;
        current = { request, revision, resolve, cancelTimer: () => {}, chunks: [], bytes: 0 };
        current.cancelTimer = schedule(() => cancel('timeout'), limits.captureTimeout);
        if (!send({ ...envelope, type: 'capture', request, revision, rect })) cancel('unavailable');
      });
    },
    receive(message: ArtifactAnnotationFrameMessage) {
      const task = current;
      if (
        !task ||
        !('request' in message) ||
        !('revision' in message) ||
        message.request !== task.request ||
        message.revision !== task.revision
      )
        return;
      if (message.type === 'capture_error') {
        cancel(message.reason);
        return;
      }
      if (message.type === 'capture_start') {
        if (
          task.start ||
          message.bytes > limits.captureBytes ||
          message.chunks !== Math.ceil(message.bytes / limits.captureChunkBytes)
        ) {
          cancel('unavailable');
          return;
        }
        task.start = message;
        return;
      }
      if (message.type === 'capture_chunk') {
        if (
          !task.start ||
          message.index !== task.chunks.length ||
          message.index >= task.start.chunks
        ) {
          cancel('unavailable');
          return;
        }
        try {
          const text = atob(message.data);
          if (btoa(text) !== message.data) throw new Error();
          const expected = Math.min(limits.captureChunkBytes, task.start.bytes - task.bytes);
          if (text.length !== expected || (task.bytes += text.length) > limits.captureBytes)
            throw new Error();
          task.chunks.push(Uint8Array.from(text, (character) => character.charCodeAt(0)));
        } catch {
          cancel('unavailable');
        }
        return;
      }
      if (message.type !== 'capture_complete') return;
      const start = task.start;
      if (!start || task.chunks.length !== start.chunks || task.bytes !== start.bytes) {
        cancel('unavailable');
        return;
      }
      const bytes = new Uint8Array(task.bytes);
      let offset = 0;
      for (const chunk of task.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const data = new DataView(bytes.buffer);
      if (
        bytes.length < 24 ||
        [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value) ||
        data.getUint32(16) !== start.width ||
        data.getUint32(20) !== start.height ||
        start.width * start.height > limits.capturePixels
      ) {
        cancel('unavailable');
        return;
      }
      current = null;
      task.cancelTimer();
      task.resolve({
        ok: true,
        blob: new Blob([bytes], { type: 'image/png' }),
        width: start.width,
        height: start.height,
      });
    },
  };
}
