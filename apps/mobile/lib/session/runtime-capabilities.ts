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
 * that refuses it with `501 feature_not_supported`: `unsupportedFeatureMessage`
 * reads the runtime's own words off that failure for the toast.
 */

import { create } from 'zustand';
import { runtimeSupports, type RuntimeCapability } from '@kortix/sdk';
import { extractSendErrorMessage, useRuntimeConnectionStore } from '@kortix/sdk/react';

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
  // The SDK's own gates read its connection store (`useRuntimeCommands` and
  // `useRuntimeConfig` ask only a runtime that lists the feature). This probe
  // is the app's one health read, so it reports there too.
  useRuntimeConnectionStore.setState({ runtimeCapabilities: capabilities });
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

/**
 * The runtime's own words when it refused a feature it does not serve
 * (`501 feature_not_supported`, e.g. "session rewind is not supported by the
 * pi harness"), or null for any other failure. The SDK surfaces the answer's
 * `error` text as the thrown message, with no status.
 */
export function unsupportedFeatureMessage(error: unknown): string | null {
  const message = extractSendErrorMessage(error);
  return /\bnot supported\b|\bread-only\b/i.test(message) ? message : null;
}
