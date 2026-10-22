import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { runtimeSupports, type RuntimeCapability } from '../core/session/health';

/**
 * Does the active session's runtime serve `capability`? Reads the
 * `capabilities` the runtime-reconnect poller last saw on `/kortix/health`,
 * so a host hides a control whose feature is absent (a pi session has no
 * rewind or compact) instead of letting it fail with a 501.
 *
 * True until a probe answers, and for a daemon built before runtime
 * capabilities existed (it runs OpenCode, which serves every feature).
 */
export function useRuntimeSupports(capability: RuntimeCapability): boolean {
  return useSandboxConnectionStore((state) => runtimeSupports(state.runtimeCapabilities, capability));
}
