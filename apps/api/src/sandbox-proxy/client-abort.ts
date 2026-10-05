import { classifyRuntimeRequest } from './runtime-request';

/**
 * The runtime session a client asked to abort, or `null` when this request is
 * not that call.
 *
 * Every client that stops a turn — web, mobile, SDK, CLI — does it with
 * `POST /kortix/runtime/sessions/:id/abort` or OpenCode's
 * `POST /session/:id/abort` through this proxy. An abort the daemon
 * issues itself (memory guard, queue interrupt, runaway guard) never passes
 * here, which is what makes this the place to record that a stop was ASKED FOR:
 * the end frame that follows is the same "Aborted" either way.
 *
 * Pure + exported so it is unit-tested without provisioning a box, like
 * `isTurnStartEnvSync`.
 */
export function clientAbortTarget(port: number, method: string, path: string): string | null {
  if (port !== 8000) return null;
  const request = classifyRuntimeRequest(method, path);
  return request.kind === 'abort' ? request.runtimeSessionId : null;
}
