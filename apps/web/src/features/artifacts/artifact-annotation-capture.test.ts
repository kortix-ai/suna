import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  type ArtifactAnnotationFrameMessage,
} from '@kortix/shared/artifact-annotations';
import { expect, test } from 'bun:test';
import { createArtifactAnnotationCapture } from './artifact-annotation-capture';

const rect = { x: 10, y: 20, width: 100, height: 100 };
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zxc8AAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);
function fixture() {
  const sent: any[] = [];
  const timers = new Map<() => void, number>();
  let throws = false;
  const capture = createArtifactAnnotationCapture(
    (message) => {
      if (throws) throw new Error('Synthetic detached frame');
      sent.push(message);
      return true;
    },
    (run, delay) => {
      timers.set(run, delay);
      return () => {
        timers.delete(run);
      };
    },
  );
  const message = (type: string, fields: object = {}) => {
    const request = sent.findLast((item) => item.type === 'capture');
    capture.receive({
      kortix: 'annotate',
      v: 1,
      request: request.request,
      revision: request.revision,
      type,
      ...fields,
    } as ArtifactAnnotationFrameMessage);
  };
  const start = (bytes = png.length, width = 1) =>
    message('capture_start', {
      mime: 'image/png',
      width,
      height: 1,
      bytes,
      chunks: Math.ceil(bytes / limits.captureChunkBytes),
    });
  return {
    capture,
    sent,
    timers,
    message,
    start,
    failTransport: () => {
      throws = true;
    },
  };
}

test('capture accepts the exact two MiB ceiling through ordered chunks and releases its timer', async () => {
  const f = fixture();
  const pending = f.capture.begin(rect, 3);
  const bytes = new Uint8Array(limits.captureBytes);
  bytes.set(png);
  f.start(bytes.length);
  let chunks = 0;
  for (let at = 0; at < bytes.length; at += limits.captureChunkBytes) {
    f.message('capture_chunk', {
      index: chunks++,
      data: Buffer.from(bytes.subarray(at, at + limits.captureChunkBytes)).toString('base64'),
    });
  }
  f.message('capture_complete');
  const result = await pending;
  expect(chunks).toBe(57);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.blob.size).toBe(limits.captureBytes);
  expect(f.timers.size).toBe(0);
  expect(JSON.stringify(f.sent)).not.toContain('base64');
});

test('duplicate starts and PNG dimension mismatches discard partial bytes', async () => {
  for (const duplicate of [true, false]) {
    const f = fixture();
    const pending = f.capture.begin(rect, 3);
    f.start(png.length, duplicate ? 1 : 2);
    if (duplicate) f.start();
    else {
      f.message('capture_chunk', { index: 0, data: Buffer.from(png).toString('base64') });
      f.message('capture_complete');
    }
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    expect(f.timers.size).toBe(0);
  }
});

test('transport exceptions settle capture and cancellation without retaining deadlines', async () => {
  const f = fixture();
  const first = f.capture.begin(rect, 3);
  f.failTransport();
  f.capture.cancel();
  expect(await first).toEqual({ ok: false, reason: 'cancelled' });
  expect(await f.capture.begin(rect, 3)).toEqual({ ok: false, reason: 'unavailable' });
  expect(f.timers.size).toBe(0);
});
