/**
 * In a shared session only the member who started the running turn, the
 * session owner or a project manager may stop it. The composer hides Stop when
 * `useSession().canStop` says no, so a refusal only reaches here when that
 * answer was stale. The server's own words are what the toast says.
 */
export const NOT_TURN_PROMPTER = 'not_turn_prompter';

/**
 * The server's message when it refused a stop, or null for any other failure.
 * A REST stop (the hold, "Stop and send") is an `ApiError` carrying the code.
 * The runtime abort answers through the sandbox proxy, whose error keeps the
 * status and the message but not the code, so a 403 counts there too.
 */
export function stopRefusalMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  if (code !== NOT_TURN_PROMPTER && status !== 403) return null;
  return typeof message === 'string' && message ? message : null;
}
