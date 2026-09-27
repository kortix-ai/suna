/**
 * Why the start screen (`app/index.tsx`) could not open a project, and what it
 * tells the user. Pure, so `bun test` covers it.
 *
 * - `session`: the API rejected the token (401 / 403). Retrying cannot help;
 *   the user signs in again.
 * - `unreachable`: no response, or a gateway error (502 / 503 / 504). The API,
 *   the auth server, or the network is down.
 * - `server`: any other API error.
 */

export type StartFailure = 'session' | 'unreachable' | 'server';

const GATEWAY_STATUSES = new Set([502, 503, 504]);

export function classifyStartFailure(error: unknown): StartFailure {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== 'number' || status === 0) return 'unreachable';
  if (status === 401 || status === 403) return 'session';
  if (GATEWAY_STATUSES.has(status)) return 'unreachable';
  return 'server';
}

export function startFailureCopy(kind: StartFailure): { title: string; body: string } {
  switch (kind) {
    case 'session':
      return { title: 'Your session has ended', body: 'Sign in again to continue.' };
    case 'unreachable':
      return { title: "Can't reach Kortix", body: 'Check your connection, then try again.' };
    case 'server':
      return { title: 'Could not open your project', body: 'Try again, or open another project.' };
  }
}
