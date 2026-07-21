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
import { connectionDisplayName, harnessPresentation, type KortixHarness, type ModelsPageConnection } from '@kortix/sdk/react';

import { METHOD_COMPATIBLE_HARNESSES } from '../llm-provider/harness-method-compat';
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

/** Maps `useModelsPage(...).connections` — the harness-scoped auth-connection
 * list — to a per-harness "is there a ready, compatible connection" lookup,
 * for O(1) reads while building rows.
 *
 * Deliberately built from `connections`, NOT `runtimes`:
 * `ModelsPageState.runtimes` is `dedupeHarnesses(agents)`-gated (one entry
 * per harness with at least one non-hidden routed agent), so a harness with
 * a fully valid ready connection but zero agents currently routed to it
 * (the normal state right after enabling a harness, before any agent picks
 * it) would never appear there and would wrongly read "Not connected".
 * `connections` carries no such agent-presence gate — it lists every
 * configured/ready/in-use auth connection regardless of routing — so this
 * derivation is used instead (WS5-P2-a review, Important finding).
 *
 * Compatibility is read off `METHOD_COMPATIBLE_HARNESSES` (the
 * `@kortix/shared` harness-descriptor inversion `harness-method-compat.ts`
 * derives, also consumed by the Models page connect flow in
 * `connect-model-modal.tsx`) rather than re-deriving auth-kind -> harness
 * membership here. */
export function connectedHarnessesFromModelsPage(
  connections: readonly ModelsPageConnection[],
): Partial<Record<AcpHarness, ModelsPageConnection>> {
  const map: Partial<Record<AcpHarness, ModelsPageConnection>> = {};
  for (const connection of connections) {
    if (connection.status !== 'ready') continue;
    for (const harness of METHOD_COMPATIBLE_HARNESSES[connection.kind] ?? []) {
      // First ready compatible connection wins per harness — a harness is
      // "Connected" the moment any one of its compatible connections is
      // ready; which one a session actually resolves to is the Models
      // page's concern (`resolveActiveConnection`), not this badge's.
      if (!map[harness as AcpHarness]) {
        map[harness as AcpHarness] = connection;
      }
    }
  }
  return map;
}

/** One row per declared runtime profile — the primary Runtime section list.
 * `connectedHarnesses` is harness-scoped (from `useModelsPage(...).connections`
 * via {@link connectedHarnessesFromModelsPage}), not profile-scoped: two
 * profiles on the same harness share connection state, which matches
 * reality (a harness either has a ready compatible connection or it
 * doesn't) — and is independent of whether any agent is currently routed
 * to that harness.
 *
 * `experimentalHarnessesEnabled` mirrors the project's `experimental_harnesses`
 * flag (same source the server-side `isExperimentalHarnessGated` selection
 * gate reads — see `apps/api/src/projects/lib/composer-capabilities.ts`).
 * When it's off, rows for an experimental harness (`ACP_HARNESS_STABILITY[harness]
 * === 'experimental'`) are FILTERED OUT entirely rather than shown
 * disabled/badged: a manifest can still declare claude/codex/pi profiles
 * (the parse/compile carve-out — see `agent-config-v2.ts`), but this view
 * must not advertise them as a real option until the project has actually
 * opted in. When the flag is on, every row shows including the
 * "Experimental" badge (`row.experimental`), unchanged from before. */
export function buildRuntimeRows(
  runtimes: Record<string, RuntimeProfile>,
  connectedHarnesses: Partial<Record<AcpHarness, ModelsPageConnection>>,
  experimentalHarnessesEnabled: boolean,
): RuntimeRowViewModel[] {
  return Object.entries(runtimes)
    .filter(
      ([, profile]) =>
        experimentalHarnessesEnabled || ACP_HARNESS_STABILITY[profile.harness] !== 'experimental',
    )
    .map(([profileName, profile]) => {
      const harness = profile.harness;
      const presentation = harnessPresentation(harness as KortixHarness);
      const connection = connectedHarnesses[harness];
      const connected = Boolean(connection);
      const connectionLabel = connection ? connectionDisplayName(connection.kind) : null;

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
