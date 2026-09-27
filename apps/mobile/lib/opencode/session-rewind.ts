/**
 * Session rewind through the session's OpenCode runtime.
 *
 * apps/web edits a sent message with `useSession().rewind(messageId)` followed
 * by a normal send. `rewind` calls the OpenCode client's `session.revert`,
 * which is `POST /session/{sessionID}/revert` with `{ messageID }`. The server
 * stages the revert pointer; the next prompt commits it and deletes the
 * reverted messages.
 *
 * Mobile does not mount the SDK's `useSession` — it talks to the runtime at
 * `sandboxUrl` directly, like `prompt_async` and `abort` in SessionPage. This
 * is the same route web calls, kept out of the component so the transport
 * lives in `lib/opencode`.
 */

export interface RevertSessionInput {
  /** The session's OpenCode base URL (`SandboxContext.sandboxUrl`). */
  sandboxUrl: string;
  sessionId: string;
  /** The user message to rewind to. It and every later message are removed. */
  messageId: string;
  token: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export async function revertSession({
  sandboxUrl,
  sessionId,
  messageId,
  token,
  fetchImpl = fetch,
}: RevertSessionInput): Promise<void> {
  const base = sandboxUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/session/${encodeURIComponent(sessionId)}/revert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messageID: messageId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Revert failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}
