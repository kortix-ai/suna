type AcpEnvelope = Record<string, unknown>;

type ReplayRow = {
  ordinal: number;
  envelope: AcpEnvelope;
};

export type PersistedAcpSseProxyOptions = {
  afterOrdinal: number;
  replay(): Promise<ReplayRow[]>;
  persist(upstreamEventId: number, envelope: AcpEnvelope): Promise<ReplayRow>;
};

function parseSseBlock(block: string): { eventId: number; envelope: AcpEnvelope } | null {
  let eventId: number | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) eventId = Number(line.slice(3).trim());
    if (line.startsWith('data:')) {
      data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
    }
  }
  if (eventId === null || !Number.isSafeInteger(eventId) || eventId < 0 || data.length === 0) {
    return null;
  }
  const envelope = JSON.parse(data.join('\n')) as unknown;
  return envelope && typeof envelope === 'object' && !Array.isArray(envelope)
    ? { eventId, envelope: envelope as AcpEnvelope }
    : null;
}

function isCursor(envelope: AcpEnvelope): boolean {
  return envelope.method === 'kortix/cursor';
}

export function createPersistedAcpSseProxy(
  upstream: ReadableStream<Uint8Array>,
  options: PersistedAcpSseProxyOptions,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let highWater = options.afterOrdinal;
      const write = (ordinal: number, envelope: AcpEnvelope) => {
        if (cancelled || ordinal <= highWater) return;
        highWater = ordinal;
        controller.enqueue(encoder.encode(`id: ${ordinal}\ndata: ${JSON.stringify(envelope)}\n\n`));
      };

      try {
        const replay = await options.replay();
        for (const row of replay) write(row.ordinal, row.envelope);
        controller.enqueue(
          encoder.encode(`id: ${highWater}\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n`),
        );

        let pending = '';
        for (;;) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          pending = pending.replaceAll('\r\n', '\n');
          const blocks = pending.split('\n\n');
          pending = blocks.pop() ?? '';
          if (done && pending.trim()) blocks.push(pending);
          for (const block of blocks) {
            let parsed: ReturnType<typeof parseSseBlock>;
            try {
              parsed = parseSseBlock(block);
            } catch (error) {
              console.warn('[acp] ignored invalid upstream SSE block', {
                error: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
            if (!parsed || isCursor(parsed.envelope)) continue;
            const stored = await options.persist(parsed.eventId, parsed.envelope);
            write(stored.ordinal, stored.envelope);
          }
          if (done) break;
        }
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
}
