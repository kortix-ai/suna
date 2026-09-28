// Hydrate the aggregate secret before importing modules that read process.env.
import './environment-secret';
import { config } from './config';
import { logger as appLogger, isLoggingTransportError } from './lib/logger';
import { captureException } from './lib/sentry';
import { ensureAbsoluteRequestUrl, getRequestUrl } from './lib/request-url';
import { runInboundAudit } from './shared/audit-edge';
import { createApp } from './app';
import { createInboundDispatch } from './inbound-dispatch';
import { createBootstrap } from './bootstrap';
import { wsHandlers as tunnelWsHandlers } from './tunnel';
import { previewWsHandlers } from './sandbox-proxy/ws-proxy';
import { appWsHandlers } from './apps/ws-proxy';

process.on('unhandledRejection', (reason: unknown) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (isLoggingTransportError(`${err.message}\n${err.stack ?? ''}`)) {
      appLogger.localError('Dropped logging-transport rejection', { error: err.message });
      return;
    }
    appLogger.error('Unhandled promise rejection', { error: err.message, stack: err.stack });
    captureException(err, { handler: 'unhandledRejection' });
  } catch {}
});

process.on('uncaughtException', (err: Error) => {
  try {
    if (isLoggingTransportError(`${err?.message ?? ''}\n${err?.stack ?? ''}`)) {
      appLogger.localError('Dropped logging-transport exception', { error: err?.message ?? String(err) });
      return;
    }
    appLogger.error('Uncaught exception', { error: err?.message ?? String(err), stack: err?.stack });
    captureException(err, { handler: 'uncaughtException' });
  } catch {}
});

const bootstrap = createBootstrap();
let dispatchInProcess: ReturnType<typeof createInboundDispatch>['dispatchInProcess'];
export const app = createApp((req) => dispatchInProcess(req), {
  draining: () => bootstrap.draining,
  schemaReady: () => bootstrap.schemaReady,
});
const inbound = createInboundDispatch(app, () => bootstrap.schemaReady);
dispatchInProcess = inbound.dispatchInProcess;

if (import.meta.main) void bootstrap.start();

export default {
  port: config.PORT,
  idleTimeout: 0,
  async fetch(req: Request, server: any): Promise<Response | undefined> {
    req = ensureAbsoluteRequestUrl(req, config.PORT);
    const url = getRequestUrl(req, config.PORT);
    return runInboundAudit(req, url, () => inbound.dispatchInbound(req, url, server));
  },
  websocket: {
    idleTimeout: 0,
    open(ws: { data: any; send: (data: any) => void; close: (code?: number, reason?: string) => void }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onOpen(ws.data.tunnelId, ws as any);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.open(ws as any);
        return;
      }
      if (ws.data?.type === 'app-ws') {
        appWsHandlers.open(ws as any);
        return;
      }
      try {
        ws.close(1011, 'unsupported websocket upgrade');
      } catch {}
    },
    message(ws: { data: any; close: (code?: number, reason?: string) => void }, message: string | Buffer) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onMessage(ws.data.tunnelId, ws as any, message);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.message(ws as any, message);
        return;
      }
      if (ws.data?.type === 'app-ws') appWsHandlers.message(ws as any, message);
    },
    close(ws: { data: any }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onClose(ws.data.tunnelId, ws as any);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.close(ws as any);
        return;
      }
      if (ws.data?.type === 'app-ws') appWsHandlers.close(ws as any);
    },
  },
};
