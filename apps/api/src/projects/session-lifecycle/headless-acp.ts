import { createSseBlockParser, isDeliverableSseBlock } from '@kortix/sdk/acp';

export type HeadlessAcpEnvelope = Record<string, unknown>;

export function selectHeadlessPermissionOption(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const options = (params as { options?: unknown }).options;
  if (!Array.isArray(options)) return null;
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    const id = (option as { optionId?: unknown }).optionId;
    const kind = (option as { kind?: unknown }).kind;
    if (typeof id === 'string' && (/^allow[_-]?once$/i.test(id) || kind === 'allow_once')) return id;
  }
  return null;
}

export async function consumeHeadlessAcpSse(
  body: ReadableStream<Uint8Array>,
  onEnvelope: (eventId: number, envelope: HeadlessAcpEnvelope) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  const parser = createSseBlockParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      const blocks = parser.push(value, done);
      for (const block of blocks) {
        if (!isDeliverableSseBlock(block)) continue;
        // Poison tolerance (WS3-P0-c fixed defect): a malformed `data:`
        // payload must not throw out of this loop — that would kill the
        // whole headless run (one bad SSE frame aborting a cron/trigger
        // turn). Skip it, log once, and keep consuming the rest of the
        // stream, exactly like `AcpClient`'s own `consumeSse` tolerates a
        // poison event via `onParseError`. The permission auto-answer flow
        // for any other event in the same stream is unaffected.
        let envelope: HeadlessAcpEnvelope;
        try {
          envelope = JSON.parse(block.data.join('\n')) as HeadlessAcpEnvelope;
        } catch (error) {
          console.warn('[session-lifecycle] skipping poison ACP SSE event', {
            eventId: block.id,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        await onEnvelope(block.id, envelope);
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
