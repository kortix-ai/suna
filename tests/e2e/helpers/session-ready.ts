import type { createApiJsonClient } from './http';

type ApiJson = ReturnType<typeof createApiJsonClient>;

export interface SessionStartState {
  stage: string;
  retriable?: boolean;
  reason?: string;
  sandbox?: { status?: string; external_id?: string | null } | null;
}

/**
 * The default bound for a real cloud session to reach `ready`.
 *
 * A fresh deployment builds the default sandbox image on first use. On a PR
 * preview that build took ~9 min, and the session sat in `provisioning` the
 * whole time. 10 min covers the build plus the boot.
 */
export const SESSION_READY_TIMEOUT_MS = 10 * 60_000;

/**
 * Poll `POST …/sessions/:id/start` until the session is `ready` with an active
 * sandbox. This is the same endpoint the web app polls, so "ready" here means
 * what the UI will see.
 *
 * Fails at once on a non-retriable stage (`failed`, a stopped runtime that the
 * server will not wake) instead of waiting out the bound. Fails at the bound
 * with the last stage, reason, and sandbox status.
 */
export async function waitForSessionReady(
  api: ApiJson,
  token: string,
  projectId: string,
  sessionId: string,
  { timeoutMs = SESSION_READY_TIMEOUT_MS, intervalMs = 2_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SessionStartState> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionStartState | null = null;
  const describe = (state: SessionStartState | null) =>
    state
      ? `stage=${state.stage} reason=${state.reason ?? 'none'} sandbox=${state.sandbox?.status ?? 'none'}`
      : 'no /start response';
  while (Date.now() < deadline) {
    last = await api<SessionStartState>(
      token,
      'POST',
      `/projects/${projectId}/sessions/${sessionId}/start?wait_ms=8000`,
      {},
    );
    if (last.stage === 'ready' && last.sandbox?.status === 'active' && last.sandbox.external_id) {
      return last;
    }
    if (last.retriable === false && last.stage !== 'ready') {
      throw new Error(`session ${sessionId} can not become ready: ${describe(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `session ${sessionId} was not ready after ${Math.round(timeoutMs / 1000)} s: ${describe(last)}`,
  );
}
