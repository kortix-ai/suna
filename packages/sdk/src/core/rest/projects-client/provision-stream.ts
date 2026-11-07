/**
 * The provision SSE body, read frame by frame: `phase` frames, then one
 * terminal `done` or `error`. Shared by `provisionProjectStream`
 * (`POST /projects/provision-stream`) and `createWorkspace`
 * (`POST /workspaces` with `Accept: text/event-stream`). Internal: not in the
 * package barrel.
 */
import { ApiError } from '../../http/api-client';
import type { KortixProject, ProvisionStreamEvent } from './projects';

/** Same value as the public `PROVISION_STREAM_UNTERMINATED_CODE` (projects.ts). */
const UNTERMINATED_CODE = 'provision_stream_unterminated';

/**
 * Parse ONE SSE frame — the text between two `\n\n` boundaries — into a
 * `ProvisionStreamEvent`, or `null` if the frame carries no `data:` line.
 *
 * Line-by-line, not `frame.startsWith('data: ')` against the whole frame:
 * SSE permits `: comment` lines and an `event:` line ahead of `data:`, and
 * the wire contract here is data-only (no `event:` line) ONLY as an
 * implementation choice the server documents, not a protocol guarantee a
 * client should hard-fail without. A parser that rejects any frame that
 * isn't EXACTLY `data: <json>` breaks the moment a spec-legal frame shows up
 * that it wasn't exactly expecting. Per the SSE spec, multiple `data:` lines
 * in one frame are joined with `\n` before parsing.
 */
/** How much of an unparseable frame's payload to surface in the thrown error.
 *  Bounded hard: a frame can be arbitrarily large, and — in the wrong build,
 *  on the wrong route — could in principle carry something sensitive (a push
 *  token). Never include more than this, and never log the payload anywhere. */
const FRAME_PARSE_ERROR_EXCERPT_LENGTH = 200;

function parseProvisionStreamFrame(frame: string): ProvisionStreamEvent | null {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;

  const payload = dataLines.join('\n');
  try {
    return JSON.parse(payload) as ProvisionStreamEvent;
  } catch (cause) {
    const excerpt =
      payload.length > FRAME_PARSE_ERROR_EXCERPT_LENGTH
        ? `${payload.slice(0, FRAME_PARSE_ERROR_EXCERPT_LENGTH)}…`
        : payload;
    // Named + attributed: a bare `SyntaxError: JSON Parse error: Expected
    // '}'` gives someone debugging a proxy that mangled one frame in
    // production nothing to go on — no mention of provisionProjectStream, no
    // mention that this came from an SSE frame, no sight of what the frame
    // actually contained.
    throw new Error(`provisionProjectStream: received an unparseable SSE frame (${excerpt})`, {
      cause,
    });
  }
}


/** The terminal `done` frame. `POST /workspaces` adds the created `workspace` to it. */
export interface ProvisionDoneFrame {
  type: 'done';
  project: KortixProject;
  workspace?: unknown;
}

/**
 * Read a 2xx provision stream to its terminal frame. Reports every frame to
 * `onEvent`, rejects with an `ApiError` on an `error` frame, and rejects with
 * `provision_stream_unterminated` when the stream closes with neither: the
 * create's result is then unknown (replay the same `idempotency_key`).
 */
export async function readProvisionStream(
  response: Response,
  onEvent: (event: ProvisionStreamEvent) => void,
): Promise<ProvisionDoneFrame> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Provision stream is unavailable on this runtime (no response body)');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let settled: ProvisionDoneFrame | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const event = parseProvisionStreamFrame(frame);
        if (!event) continue;
        onEvent(event);
        // The same `ApiError` shape as a pre-stream denial, so a host
        // classifying create failures gets identical `.status`/`.code`.
        if (event.type === 'error') {
          throw new ApiError(event.error, { status: event.status, code: event.code });
        }
        if (event.type === 'done') settled = event as ProvisionDoneFrame;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  // A stream that closes without a terminal event is a failure, not a
  // success: resolving would hand the caller an undefined project id. The
  // stable code lets the host replay the SAME idempotency key over the plain
  // route and recover the true outcome (KRTX-1754).
  if (!settled) {
    throw new ApiError('Provision stream ended without a result', { code: UNTERMINATED_CODE });
  }
  return settled;
}
