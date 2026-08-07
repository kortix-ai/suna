import { appRuntimes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { type SandboxProviderName } from '../config';
import { markComputeSessionAlive } from '../billing/services/compute-metering';
import { db } from '../shared/db';
import { AppHostingProvider } from './hosting';
import {
  appUpstreamHeaders,
  ensureAppRuntimeRunning,
  loadPublicApp,
  resolveAppRequest,
  verifyAppEdgeRequest,
} from './public-proxy';

const WS_ACTIVITY_LEASE_MS = 60_000;

export interface AppWsData {
  type: 'app-ws';
  url: string;
  headers: Record<string, string>;
  runtimeId: string;
  idleTimeoutSeconds: number;
  upstream?: WebSocket;
  ready?: boolean;
  queue?: Array<string | Buffer | ArrayBuffer | Uint8Array>;
  renewTimer?: ReturnType<typeof setInterval>;
}

interface ServerWs {
  data: AppWsData;
  send: (data: string | ArrayBufferView | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
}

function websocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function stampActivity(runtimeId: string, idleTimeoutSeconds: number): Promise<void> {
  const now = new Date();
  await Promise.all([
    db.update(appRuntimes).set({
      lastRequestAt: now,
      activityLeaseUntil: new Date(now.getTime() + WS_ACTIVITY_LEASE_MS),
      idleDeadlineAt: new Date(now.getTime() + idleTimeoutSeconds * 1000),
      updatedAt: now,
    }).where(eq(appRuntimes.runtimeId, runtimeId)),
    markComputeSessionAlive(runtimeId, now),
  ]);
}

export async function prepareAppWsUpgrade(
  request: Request,
  url: URL,
): Promise<{ ok: true; data: AppWsData } | { ok: false; status: number; message: string }> {
  const matched = resolveAppRequest(request, url);
  if (!matched) return { ok: false, status: 404, message: 'not an App hostname' };
  if (!verifyAppEdgeRequest(request, url, matched.local, matched.publicHost)) {
    return { ok: false, status: 403, message: 'Invalid App edge signature' };
  }
  const loaded = await loadPublicApp(matched.routeKey);
  if (!loaded) return { ok: false, status: 404, message: 'App not found' };
  try {
    const hosting = new AppHostingProvider();
    const runtime = await ensureAppRuntimeRunning(loaded, hosting);
    await stampActivity(runtime.runtimeId, loaded.app.idleTimeoutSeconds);
    const ingress = await hosting.ingress(
      runtime.provider as SandboxProviderName,
      runtime.externalId,
      'websocket',
    );
    const headers = appUpstreamHeaders(request, ingress.headers, matched.publicHost);
    const headerObject = Object.fromEntries(headers.entries());
    return {
      ok: true,
      data: {
        type: 'app-ws',
        url: websocketUrl(`${ingress.url.replace(/\/$/, '')}${url.pathname}${url.search}`),
        headers: headerObject,
        runtimeId: runtime.runtimeId,
        idleTimeoutSeconds: loaded.app.idleTimeoutSeconds,
      },
    };
  } catch (error) {
    if (error instanceof Response) return { ok: false, status: error.status, message: 'App is stopped' };
    return { ok: false, status: 503, message: 'App is temporarily unavailable' };
  }
}

function sanitizeCloseCode(code: number | undefined): number {
  if (
    typeof code === 'number' &&
    ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999))
  ) return code;
  return 4500;
}

export const appWsHandlers = {
  open(ws: ServerWs) {
    const state = ws.data;
    state.queue = [];
    state.ready = false;
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(state.url, { headers: state.headers } as any);
    } catch {
      ws.close(1011, 'upstream connect failed');
      return;
    }
    state.upstream = upstream;
    upstream.binaryType = 'arraybuffer';
    state.renewTimer = setInterval(() => {
      void stampActivity(state.runtimeId, state.idleTimeoutSeconds);
    }, 30_000);
    upstream.onopen = () => {
      state.ready = true;
      const queue = state.queue ?? [];
      state.queue = [];
      for (const message of queue) {
        try { upstream.send(message as any); } catch {}
      }
    };
    upstream.onmessage = (event) => {
      try { ws.send(event.data as any); } catch {}
    };
    upstream.onclose = (event) => {
      try { ws.close(sanitizeCloseCode(event.code), event.reason.slice(0, 120)); } catch {}
    };
    upstream.onerror = () => {
      try { ws.close(4502, 'upstream error'); } catch {}
    };
  },

  message(ws: ServerWs, message: string | Buffer) {
    const state = ws.data;
    if (state.ready && state.upstream?.readyState === WebSocket.OPEN) {
      try { state.upstream.send(message as any); } catch {}
    } else {
      (state.queue ??= []).push(message);
    }
  },

  close(ws: ServerWs) {
    if (ws.data.renewTimer) clearInterval(ws.data.renewTimer);
    try { ws.data.upstream?.close(); } catch {}
    void db.update(appRuntimes).set({ activityLeaseUntil: null, updatedAt: new Date() })
      .where(eq(appRuntimes.runtimeId, ws.data.runtimeId));
  },
};
