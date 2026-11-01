import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { hasSessionDesktop } from '../core/session/health';

/**
 * Does the active session's computer have a desktop to show? Reads the
 * `capabilities` the runtime-reconnect poller last saw on `/kortix/health`
 * (`machine.desktop`, see {@link hasSessionDesktop}).
 *
 * `undefined` until the session's daemon answers, so a host can wait instead
 * of flashing "no desktop" on a computer that has one.
 */
export function useHasSessionDesktop(): boolean | undefined {
  return useSandboxConnectionStore((state) =>
    state.runtimeCapabilities === null ? undefined : hasSessionDesktop(state.runtimeCapabilities),
  );
}
