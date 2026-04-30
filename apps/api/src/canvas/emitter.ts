/**
 * canvasEmit — write a CanvasMessage as an SSE event.
 *
 * Format: event: canvas\ndata: <json>\n\n
 */
import type { CanvasMessage } from './types';

const encoder = new TextEncoder();

export async function canvasEmit(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: CanvasMessage,
): Promise<void> {
  const payload = `event: canvas\ndata: ${JSON.stringify(message)}\n\n`;
  await writer.write(encoder.encode(payload));
}
