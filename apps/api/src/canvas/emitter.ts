/**
 * canvasEmit — write a CanvasMessage as a Server-Sent Event to a streaming
 * Response body. The SSE format is:
 *
 *   event: canvas\n
 *   data: <json>\n\n
 *
 * Callers hold a reference to the WritableStreamDefaultWriter obtained from
 * the TransformStream they passed to the Response constructor. The existing
 * text stream uses the same writer — canvas events are interleaved without
 * disrupting the text flow because SSE clients dispatch on `event` name.
 */

import type { CanvasMessage } from './types';

const encoder = new TextEncoder();

/**
 * Write one canvas SSE event to `writer`.
 *
 * @param writer  WritableStreamDefaultWriter from the outgoing Response body.
 * @param message A fully-constructed CanvasMessage (already narrowed to kind).
 */
export async function canvasEmit(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: CanvasMessage,
): Promise<void> {
  const payload = `event: canvas\ndata: ${JSON.stringify(message)}\n\n`;
  await writer.write(encoder.encode(payload));
}
