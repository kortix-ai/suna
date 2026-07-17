/**
 * Pure view-model for the Runtime customize section (WS5-P2-a) — no React,
 * no query client. Turns the project's declared runtime profiles plus
 * per-harness connection state into de-jargoned rows: a label from the
 * canonical harness descriptor, a plain-words meta line, and the two facts a
 * viewer actually needs (is it still experimental, is it connected).
 *
 * Kept separate from `runtime-view.tsx` so the derivation is unit-testable
 * without mounting React Query, and so component tests can mock the
 * data-fetching hooks at the module boundary while this pure logic stays
 * real.
 */

import type { AcpHarness, RuntimeProfile } from '@kortix/sdk/projects-client';
import { connectionDisplayName, harnessPresentation, type KortixHarness, type ModelsPageRuntime } from '@kortix/sdk/react';

import { ACP_HARNESS_STABILITY } from './runtime-profile-options';

export interface RuntimeRowViewModel {
  /** The manifest profile key (`runtime-1`, `claude`, …) — identity only,
   * never shown in the primary row (that's the profile-slug jargon the
   * Advanced disclosure owns). Used only as the React list key. */
  profileName: string;
  harness: AcpHarness;
  /** Display label from the canonical harness descriptor (`harnessPresentation`). */
  label: string;
  /** Plain-words meta line — what it runs and how it's connected. No manifest
   * keys, no file paths. */
  meta: string;
  /** True for a harness whose `HARNESSES[id].stability` is `'experimental'`. */
  experimental: boolean;
  connected: boolean;
}

/** Maps `useModelsPage(...).runtimes` (keyed by harness id) for O(1) lookups
 * while building rows. */
export function connectionsByHarnessFromModelsPage(
  runtimes: readonly ModelsPageRuntime[],
): Partial<Record<AcpHarness, ModelsPageRuntime>> {
  const map: Partial<Record<AcpHarness, ModelsPageRuntime>> = {};
  for (const runtime of runtimes) {
    map[runtime.harness as AcpHarness] = runtime;
  }
  return map;
}

/** One row per declared runtime profile — the primary Runtime section list.
 * `connectionsByHarness` is harness-scoped (from `useModelsPage`), not
 * profile-scoped: two profiles on the same harness share connection state,
 * which matches reality (a harness either has a resolved auth or it doesn't). */
export function buildRuntimeRows(
  runtimes: Record<string, RuntimeProfile>,
  connectionsByHarness: Partial<Record<AcpHarness, ModelsPageRuntime>>,
): RuntimeRowViewModel[] {
  return Object.entries(runtimes).map(([profileName, profile]) => {
    const harness = profile.harness;
    const presentation = harnessPresentation(harness as KortixHarness);
    const connection = connectionsByHarness[harness];
    const connected = connection?.status === 'ready';
    const connectionLabel =
      connected && connection?.selectedConnectionId
        ? connectionDisplayName(connection.selectedConnectionId)
        : null;

    return {
      profileName,
      harness,
      label: presentation.label,
      meta: connectionLabel
        ? `Runs ${presentation.label} · Connected via ${connectionLabel}`
        : `Runs ${presentation.label} · Not connected`,
      experimental: ACP_HARNESS_STABILITY[harness] === 'experimental',
      connected,
    };
  });
}
