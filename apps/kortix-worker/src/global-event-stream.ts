import type { ServerResponse } from 'node:http';
import type { WorkerEventBus } from './runtime-surface.ts';

export function serveGlobalEventStream(
  res: ServerResponse,
  bus: WorkerEventBus,
  directory: string,
  options: { heartbeatMs: number; maxBufferedBytes?: number },
): void {
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  let closed = false;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };
  const write = (chunk: string) => {
    if (closed) return;
    if (res.writableLength + Buffer.byteLength(chunk) > maxBufferedBytes) {
      cleanup();
      res.destroy();
      return;
    }
    try {
      res.write(chunk);
    } catch {
      cleanup();
      res.destroy();
    }
  };
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  unsubscribe = bus.subscribe(
    (event) => {
      const envelope = {
        directory,
        payload: {
          id: `evt_${bus.epoch}_${event.seq}`,
          type: event.type,
          properties: event.payload,
        },
      };
      write(`id: ${event.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
    },
    { since: null, epoch: null },
  ).unsubscribe;
  const transportEvent = (type: 'server.connected' | 'server.heartbeat') =>
    write(`data: ${JSON.stringify({ directory, payload: { type, properties: {} } })}\n\n`);
  heartbeat = setInterval(() => transportEvent('server.heartbeat'), options.heartbeatMs);
  heartbeat.unref?.();
  res.once('close', cleanup);
  res.once('error', cleanup);
  res.flushHeaders?.();
  transportEvent('server.connected');
}
