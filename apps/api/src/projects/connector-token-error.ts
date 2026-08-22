/**
 * Thrown by `provisionSessionSandbox` when the per-session connector token
 * (`kortix_pat_…`) could not be minted.
 *
 * Gateway mode is the only session mode: OpenCode sees exactly one provider,
 * `kortix`, authenticated with this token. A box without it has no model
 * access, and every later env push is rejected by the daemon
 * (`KORTIX_CLI_TOKEN is unavailable`), so the session would LOOK provisioned
 * and be dead. Provisioning therefore fails closed — the row is marked
 * `error` with a user-visible reason and this error is thrown to the caller,
 * which marks the project session `failed` with the same message.
 */
export class ConnectorTokenUnavailableError extends Error {
  constructor(sessionId: string, cause?: unknown) {
    super(
      `Kortix could not mint the session credential (connector token) for session ${sessionId}. ` +
        'The session has no model access. Retry; if it persists, contact support.',
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = 'ConnectorTokenUnavailableError';
  }
}
