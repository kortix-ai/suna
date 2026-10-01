/**
 * What the session's runtime serves (E1). A pi session has no rewind, compact,
 * or slash commands; an OpenCode session has all of them. The runtime lists
 * its features in `/kortix/health` `capabilities`, which
 * `useSandboxReachability` (the pill's 10 s poller, the one health probe of
 * the open session) records here. A screen hides the control of a feature the
 * runtime does not serve (`useRuntimeSupports`).
 *
 * Until a probe answers, every feature reads served (the SDK's
 * `runtimeSupports` rule). A tap in that window can still reach a runtime
 * that refuses it with `501 feature_not_supported`: `featureNotSupportedError`
 * turns that answer into the runtime's own words for the toast.
 */

import { create } from 'zustand';
import { FEATURE_NOT_SUPPORTED_CODE, runtimeSupports, type RuntimeCapability } from '@kortix/sdk';

interface RuntimeCapabilitiesState {
  /** The computer the list came from: a list says nothing about another one. */
  sandboxUrl: string | null;
  capabilities: readonly string[] | null;
}

const useRuntimeCapabilitiesStore = create<RuntimeCapabilitiesState>()(() => ({
  sandboxUrl: null,
  capabilities: null,
}));

/** Record a health answer's `capabilities`. An answer without a list (a parked
 *  computer, where the control plane answers) keeps what the runtime said. */
export function recordRuntimeCapabilities(sandboxUrl: string, capabilities: unknown): void {
  if (!Array.isArray(capabilities)) return;
  useRuntimeCapabilitiesStore.setState({ sandboxUrl, capabilities });
}

/** Does the runtime at `sandboxUrl` serve `capability`? */
export function runtimeSupportsAt(
  sandboxUrl: string | undefined,
  capability: RuntimeCapability,
  state: RuntimeCapabilitiesState = useRuntimeCapabilitiesStore.getState(),
): boolean {
  return runtimeSupports(state.sandboxUrl === sandboxUrl ? state.capabilities : null, capability);
}

export function useRuntimeSupports(sandboxUrl: string | undefined, capability: RuntimeCapability): boolean {
  return useRuntimeCapabilitiesStore((state) => runtimeSupportsAt(sandboxUrl, capability, state));
}

/** A runtime's `501 feature_not_supported` answer. `message` is its `error`, already user-readable. */
export class FeatureNotSupportedError extends Error {
  override name = 'FeatureNotSupportedError';
}

/** The typed error for a `501 { code: 'feature_not_supported', error }` answer; null for any other. */
export function featureNotSupportedError(status: number, body: string): FeatureNotSupportedError | null {
  if (status !== 501) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
    return parsed?.code === FEATURE_NOT_SUPPORTED_CODE && typeof parsed.error === 'string' && parsed.error
      ? new FeatureNotSupportedError(parsed.error)
      : null;
  } catch {
    return null;
  }
}
