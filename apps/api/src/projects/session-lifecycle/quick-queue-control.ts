import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

type SandboxEndpoint = { url: string; headers: Record<string, string> };
type QuickQueueRequest = (url: string, init: RequestInit) => Promise<Response>;
type QuickQueueControl =
  | { kind: 'arm'; promptId: string; opencodeSessionId: string; messageId: string }
  | { kind: 'disarm'; promptId: string }
  | { kind: 'disarm-all' };

/** Whether the daemon served the control, and WHY it did not. The arm's warn
 *  carries the reason, so an unreachable runtime is named, not just implied. */
export type QuickQueueControlOutcome = { ok: true; reason: null } | { ok: false; reason: string };

/** A signed, bounded control request. The inbox row remains durable if this fails. */
export async function sendQuickQueueControl(
  endpoint: SandboxEndpoint,
  control: QuickQueueControl,
  request: QuickQueueRequest = fetch,
): Promise<QuickQueueControlOutcome> {
  const body = control.kind === 'arm'
    ? {
        prompt_id: control.promptId,
        runtime_session_id: control.opencodeSessionId,
        // The pre-W3 name, for a daemon built before W3.
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
    if (!response.ok) return { ok: false, reason: `status ${response.status}` };
    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return { ok: false, reason: `content-type ${contentType ?? 'absent'}` };
    }
    const result = await response.json().catch(() => null) as { armed?: unknown } | null;
    if (result?.armed !== (control.kind === 'arm')) {
      return { ok: false, reason: `daemon answered armed=${String(result?.armed)}` };
    }
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
