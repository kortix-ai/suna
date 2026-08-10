import { ApiError, type ApiClientOptions, backendApi } from '../../http/api-client';

/** Server-observed boundaries for a live session-config reload. */
export type SessionReloadPhase =
  | 'checking-session'
  | 'refreshing-workspace'
  | 'compiling-config'
  | 'applying-config'
  | 'confirming-config';

/** One frame from a streamed session-config reload route. */
export type SessionReloadStreamEvent<TResult> =
  | { type: 'phase'; phase: SessionReloadPhase }
  | { type: 'done'; result: TResult }
  | {
      type: 'error';
      error: string;
      code?: string;
      status?: number;
      reason?: string;
    };

function parseSessionReloadStreamFrame<TResult>(
  frame: string,
): SessionReloadStreamEvent<TResult> | null {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;

  try {
    return JSON.parse(dataLines.join('\n')) as SessionReloadStreamEvent<TResult>;
  } catch (cause) {
    throw new Error('Session reload stream received an invalid SSE frame', { cause });
  }
}

/**
 * Shared stream transport owned by the canonical Workspace client.
 *
 * The deprecated Project client supplies its legacy route at its public
 * boundary. Parsing, errors, terminal-frame enforcement, and cancellation stay
 * here so the compatibility namespace cannot diverge from Workspace behavior.
 */
export async function requestSessionConfigReloadStream<TResult>(
  path: string,
  input: { refresh_repo?: boolean; force?: boolean },
  onEvent: (event: SessionReloadStreamEvent<TResult>) => void,
  options: ApiClientOptions = {},
): Promise<TResult> {
  const response = await backendApi.postStream(path, input, options);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      reason?: string;
    } | null;
    throw new ApiError(body?.error || `Reload failed: HTTP ${response.status}`, {
      status: response.status,
      code: body?.code,
      data: body,
    });
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Reload stream is unavailable on this runtime (no response body)');

  const decoder = new TextDecoder();
  let buffer = '';
  let settled: TResult | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const event = parseSessionReloadStreamFrame<TResult>(frame);
        if (!event) continue;
        onEvent(event);
        if (event.type === 'error') {
          throw new ApiError(event.error, {
            status: event.status,
            code: event.code,
            data: { reason: event.reason },
          });
        }
        if (event.type === 'done') settled = event.result;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!settled) throw new Error('Reload stream ended without a result');
  return settled;
}
