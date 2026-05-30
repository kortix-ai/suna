export function buildSessionNotFoundError(id: string): Error {
  return new Error(`PTY session '${id}' not found. Use pty_list to see active sessions.`)
}

/**
 * Helper to DRY up session-get/null-check logic
 * - manager: object with a getSession(id) or similar method
 * - id: session id
 * - fn: function called with session if found
 * - defaultValue: what to return if not found (default null)
 */
export function withSession<TSession, TResult>(
  manager: { getSession(id: string): TSession | null },
  id: string,
  fn: (session: TSession) => TResult,
  defaultValue: TResult
): TResult {
  const session = manager.getSession(id)
  if (!session) return defaultValue
  return fn(session)
}
