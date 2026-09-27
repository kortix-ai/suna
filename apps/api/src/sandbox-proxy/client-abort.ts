/**
 * The OpenCode session a client asked to abort, or `null` when this request is
 * not that call.
 *
 * Every client that stops a turn — web, mobile, SDK, CLI — does it with
 * OpenCode's `POST /session/:id/abort` through this proxy. An abort the daemon
 * issues itself (memory guard, queue interrupt, runaway guard) never passes
 * here, which is what makes this the place to record that a stop was ASKED FOR:
 * the end frame that follows is the same "Aborted" either way.
 *
 * Pure + exported so it is unit-tested without provisioning a box, like
 * `isTurnStartEnvSync`.
 */
export function clientAbortTarget(port: number, method: string, path: string): string | null {
  if (port !== 8000) return null;
  if (method.toUpperCase() !== 'POST') return null;
  const match = /^\/session\/([^/]+)\/abort\/?(?:$|[?#])/.exec(path);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
