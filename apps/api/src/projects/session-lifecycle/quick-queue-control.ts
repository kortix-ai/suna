import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

type SandboxEndpoint = { url: string; headers: Record<string, string> };
type QuickQueueRequest = (url: string, init: RequestInit) => Promise<Response>;
type QuickQueueControl =
  | { kind: 'arm'; promptId: string; opencodeSessionId: string; messageId: string }
  | { kind: 'disarm'; promptId: string }
  | { kind: 'disarm-all' };

/** A signed, bounded control request. The inbox row remains durable if this fails. */
export async function sendQuickQueueControl(
  endpoint: SandboxEndpoint,
  control: QuickQueueControl,
  request: QuickQueueRequest = fetch,
): Promise<boolean> {
  const body = control.kind === 'arm'
    ? {
        prompt_id: control.promptId,
        opencode_session_id: control.opencodeSessionId,
        turn_message_id: control.messageId,
      }
    : control.kind === 'disarm'
      ? { prompt_id: control.promptId }
      : { all: true };
  try {
    const response = await request(`${endpoint.url}/kortix/abort/after-tool`, {
      method: control.kind === 'arm' ? 'POST' : 'DELETE',
      headers: { ...sandboxRuntimeRequestHeaders(endpoint.headers), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      return false;
    }
    const result = await response.json().catch(() => null) as { armed?: unknown } | null;
    return result?.armed === (control.kind === 'arm');
  } catch {
    return false;
  }
}
