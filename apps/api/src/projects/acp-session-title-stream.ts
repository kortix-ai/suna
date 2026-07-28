export type RuntimeSessionTitleEvent = {
  sessionId: string;
  title: string;
};

type RuntimeSessionTitleObserverOptions = {
  protocol: 'acp' | 'rest';
  expectedSessionId?: string;
  onTitle(event: RuntimeSessionTitleEvent): Promise<void> | void;
  onError?(error: unknown): void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function realTitle(value: unknown): string | null {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || /^new session\b/i.test(title)) return null;
  return title;
}

function titleFromAcpEnvelope(
  envelope: unknown,
  expectedSessionId: string,
): RuntimeSessionTitleEvent | null {
  if (!isObject(envelope) || envelope.method !== 'session/update') return null;
  const params = isObject(envelope.params) ? envelope.params : null;
  if (!params || params.sessionId !== expectedSessionId) return null;
  const update = isObject(params.update) ? params.update : null;
  if (!update || update.sessionUpdate !== 'session_info_update') return null;
  const title = realTitle(update.title);
  return title ? { sessionId: expectedSessionId, title } : null;
}

function titleFromRestEnvelope(
  envelope: unknown,
  expectedSessionId?: string,
): RuntimeSessionTitleEvent | null {
  if (!isObject(envelope)) return null;
  const event = isObject(envelope.payload) ? envelope.payload : envelope;
  if (event.type !== 'session.updated') return null;
  const properties = isObject(event.properties) ? event.properties : null;
  if (!properties) return null;
  const info = isObject(properties.info) ? properties.info : properties;
  const sessionId = typeof info.id === 'string' ? info.id : '';
  if (!sessionId || (expectedSessionId && sessionId !== expectedSessionId)) return null;
  const title = realTitle(info.title);
  return title ? { sessionId, title } : null;
}

function titleFromSseBlock(
  block: string,
  options: Pick<RuntimeSessionTitleObserverOptions, 'protocol' | 'expectedSessionId'>,
): RuntimeSessionTitleEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;

  const envelope = JSON.parse(data) as unknown;
  return options.protocol === 'acp'
    ? titleFromAcpEnvelope(envelope, options.expectedSessionId ?? '')
    : titleFromRestEnvelope(envelope, options.expectedSessionId);
}

/**
 * Observe runtime session-title updates without changing the proxied SSE bytes.
 * The title callback finishes before the matching chunk reaches the client.
 */
export function observeRuntimeSessionTitleStream(
  body: ReadableStream<Uint8Array>,
  options: RuntimeSessionTitleObserverOptions,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '';

  const processBlocks = async (flush = false): Promise<void> => {
    const blocks = pending.split('\n\n');
    pending = blocks.pop() ?? '';
    if (flush && pending.trim()) {
      blocks.push(pending);
      pending = '';
    }
    for (const block of blocks) {
      try {
        const event = titleFromSseBlock(block, options);
        if (event) await options.onTitle(event);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
        await processBlocks();
        controller.enqueue(chunk);
      },
      async flush() {
        pending += decoder.decode().replaceAll('\r\n', '\n');
        await processBlocks(true);
      },
    }),
  );
}
