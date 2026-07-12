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
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (done && buffer.trim()) buffer += '\n\n';
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary).replace(/\r/g, '');
        buffer = buffer.slice(boundary + 2);
        let eventId: number | null = null;
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) eventId = Number(line.slice(3).trim());
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (eventId !== null && Number.isSafeInteger(eventId) && data.length) {
          const parsed = JSON.parse(data.join('\n')) as HeadlessAcpEnvelope;
          await onEnvelope(eventId, parsed);
        }
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
