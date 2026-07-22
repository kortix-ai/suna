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
import { ACP_HARNESS_LABELS, ACP_HARNESS_STABILITY } from './runtime-profile-options';

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

export type SavePhase = 'idle' | 'saving' | 'done';

/** Strong ease-out (`ease-out-quint`). Front-loads the travel so the bar reads
 * as responsive within the first frames — the built-in `ease-out` is too weak
 * for this. */
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

/**
 * Inline style for the harness `Select`'s saving bar, by phase. Pure so the
 * timing contract is assertable without a DOM (the bar is `aria-hidden` and
 * only reachable by driving a Radix `Select`, which this test harness can't).
 *
 * `transform: scaleX()` with a left origin, never `width` — width is a layout
 * property and would reflow every frame; scaleX composites on the GPU.
 *
 * The bar is indeterminate wearing determinate clothes: a git-backed manifest
 * commit has no knowable duration, so `saving` eases to 90% and holds rather
 * than completing on a timer it can't honor. `done` finishes fast (the system
 * responding) with the fade trailing behind, so 100% is actually seen.
 */
export function savingBarStyle(
  phase: SavePhase,
  reduceMotion: boolean,
): { transform: string; opacity: number; transition: string } {
  const scale = phase === 'idle' ? 0 : phase === 'saving' ? 0.9 : 1;
  return {
    // Reduced motion keeps the appear/disappear signal and drops only the
    // travel — removing movement, not information.
    transform: reduceMotion ? 'none' : `scaleX(${scale})`,
    opacity: phase === 'saving' ? 1 : 0,
    transition: reduceMotion
      ? 'opacity 200ms ease'
      : phase === 'saving'
        ? `transform 900ms ${EASE_OUT}, opacity 120ms ease`
        : `transform 180ms ${EASE_OUT}, opacity 200ms ease 140ms`,
  };
}

/**
 * Options for the Runtime section's harness `Select`, labelled the way this
 * de-jargoned section labels everything else: by harness, not by manifest key.
 *
 * The profile key is appended ONLY when two profiles resolve to the same
 * harness, because that is the only case where the bare label is genuinely
 * ambiguous. The agent editor appends it whenever key !== harness id, which is
 * right for an advanced routing surface but wrong here — "Claude Code ·
 * my-slug" hands a profile slug to exactly the person this control exists for.
 * Disambiguate when ambiguous; stay quiet otherwise.
 */
export function runtimeSelectOptions(
  runtimes: Record<string, { harness: AcpHarness }>,
): Array<{ value: string; label: string }> {
  const perHarness = new Map<AcpHarness, number>();
  for (const profile of Object.values(runtimes)) {
    perHarness.set(profile.harness, (perHarness.get(profile.harness) ?? 0) + 1);
  }
  return Object.entries(runtimes).map(([name, profile]) => ({
    value: name,
    label:
      (perHarness.get(profile.harness) ?? 0) > 1
        ? `${ACP_HARNESS_LABELS[profile.harness]} · ${name}`
        : ACP_HARNESS_LABELS[profile.harness],
  }));
}

/**
 * Every cached read derived from the project manifest's runtime profiles —
 * i.e. everything a write to `runtimes` makes stale. Returned as query-key
 * PREFIXES for `invalidateQueries`, which matches partially by default.
 *
 * This exists because the Runtime section reads one manifest through four
 * separate cache entries, and the two write paths (`updateRuntimeProfiles`
 * in the Advanced editor, `enableAcpRuntimeProfiles` in the enable card)
 * each invalidated their own ad-hoc subset. Both omitted `agent-config` —
 * which is precisely the entry the "Coding harness" `Select` builds its
 * options from — so adding a profile or "Enable all harnesses" refreshed the
 * row list while the Select kept serving its stale `runtimes` map for the
 * whole 15s `staleTime`. One list, one place to add to.
 *
 * `['agent-config', projectId]` is intentionally two segments, not three:
 * every agent in the project routes through these profiles, not just the
 * default one, so all of them go stale together.
 */
export function runtimeManifestQueryKeys(projectId: string): Array<readonly unknown[]> {
  return [
    // The primary row list + the Advanced editor's own profile list.
    ['runtime-profiles', projectId],
    // Compiled project config (composer capabilities, harness gating).
    ['project-config', projectId],
    // The agents list, and `runtime_default_agent` for the Select's target.
    ['project-detail', projectId],
    // `ActiveRuntimeSelector`'s option list AND its current value — the one
    // that used to be missed.
    ['agent-config', projectId],
  ];
}

/**
 * One agent's declared routing, as the project-detail summary reports it
 * (`ProjectConfigSummary['agents']`). `runtime` is null/absent for
 * runtime-discovered agents, which `agents:` doesn't govern and the manifest
 * therefore never validates against `runtimes`.
 */
export interface RuntimeAgentRef {
  name: string;
  runtime?: string | null;
}

/** A pending "this agent moves to that profile" edit, keyed by agent name.
 * Lives only for the duration of one Advanced-editor session. */
export type RuntimeReassignments = Record<string, string>;

/** The profile an agent would run on if the draft were saved right now —
 * its pending reassignment if it has one, otherwise what the manifest says. */
function effectiveRuntime(
  agent: RuntimeAgentRef,
  reassignments: RuntimeReassignments,
): string | null {
  return reassignments[agent.name] ?? agent.runtime ?? null;
}

/**
 * Agents that a draft would strand — i.e. whose effective `runtime` names a
 * profile the draft no longer declares.
 *
 * This is the frontend mirror of the single manifest rule that produced the
 * unexplained 400: `manifest-schema`'s v3 validator walks every
 * `agents.<name>.runtime` and errors with `runtime "<x>" does not match a
 * declared runtime profile` when it isn't a key of `runtimes`. `PUT
 * /runtime-profiles` re-validates the WHOLE manifest after swapping the
 * `runtimes` map in (`applyRuntimeProfilesV3`), so removing a referenced
 * profile is rejected wholesale — the write never lands, which is why the
 * Coding harness Select appeared "stuck" on the removed harness.
 *
 * Pending reassignments are re-checked against the draft rather than trusted:
 * a user can record "move `coding` to `opencode`" and then remove `opencode`
 * too, and that agent is stranded again.
 */
export function orphanedAgentRefs(
  agents: readonly RuntimeAgentRef[],
  draftRuntimes: Record<string, RuntimeProfile>,
  reassignments: RuntimeReassignments,
): Array<{ name: string; runtime: string }> {
  const declared = new Set(Object.keys(draftRuntimes));
  return agents.flatMap((agent) => {
    const runtime = effectiveRuntime(agent, reassignments);
    return runtime && !declared.has(runtime) ? [{ name: agent.name, runtime }] : [];
  });
}

/** The agents that would run on `profileName` if the draft were saved now —
 * i.e. exactly who a removal of that profile has to speak for. */
export function agentsOnProfile(
  agents: readonly RuntimeAgentRef[],
  reassignments: RuntimeReassignments,
  profileName: string,
): string[] {
  return agents
    .filter((agent) => effectiveRuntime(agent, reassignments) === profileName)
    .map((agent) => agent.name);
}

/** Agent names as prose, for copy that has to name them in a sentence
 * ("coding and review run on it"). Oxford comma at three or more. */
export function listAgentNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * Where agents should go when their profile is removed: a surviving profile on
 * the SAME harness if one exists (the move nobody has to think about — same
 * runtime, different key), otherwise the first surviving profile. Null when the
 * draft has nothing left to move to.
 */
export function pickFallbackProfile(
  draftRuntimes: Record<string, RuntimeProfile>,
  harness: AcpHarness | undefined,
): string | null {
  const entries = Object.entries(draftRuntimes);
  const sameHarness = entries.find(([, profile]) => profile.harness === harness);
  return (sameHarness ?? entries[0])?.[0] ?? null;
}

/**
 * Renaming a profile is not removing it: an agent pointing at the old key
 * plainly means the same profile, so it follows the rename instead of being
 * stranded by it. Returns the next reassignment map.
 *
 * Without this, `rename('codex', 'codex-sandbox')` produced exactly the same
 * dangling reference — and the same 400 — as a removal, with no dialog
 * anywhere to explain it.
 */
export function carryReferencesThroughRename(
  agents: readonly RuntimeAgentRef[],
  reassignments: RuntimeReassignments,
  from: string,
  to: string,
): RuntimeReassignments {
  const next = { ...reassignments };
  for (const [name, target] of Object.entries(next)) {
    if (target === from) next[name] = to;
  }
  for (const agent of agents) {
    if (effectiveRuntime(agent, next) === from) next[agent.name] = to;
  }
  return next;
}

/** One write in a runtime-profiles save. `harness` rides along on an agent
 * step so the caller can hand it to {@link nextAgentBlockForRuntime}, which
 * needs it to drop a stale `agent` field. */
export type RuntimeSaveStep =
  | { kind: 'runtimes'; runtimes: Record<string, RuntimeProfile> }
  | { kind: 'agent'; agent: string; runtime: string; harness: AcpHarness | undefined };

/**
 * Order the writes a runtime-profiles save needs so that EVERY intermediate
 * state is a manifest the v3 validator accepts. This is the fix for the 400:
 * the editor used to emit one PUT of the `runtimes` map and leave the agents
 * that referenced a removed profile dangling.
 *
 * The ordering rule is forced by which document each route validates:
 *
 * 1. **Bridge** (only when needed) — an agent write is validated against the
 *    manifest as it stands on the server, so moving an agent onto a profile
 *    that exists only in this draft would 400 in its own right. Declaring the
 *    UNION of saved and draft profiles first is always valid: every existing
 *    reference still resolves and the new target now exists.
 * 2. **Move the agents** — reassignment is legal while the old profile is
 *    still declared. This is the step that never existed.
 * 3. **Write the draft** — now that nothing references the removed profiles,
 *    dropping them validates.
 *
 * The common case (no removals, so no reassignments) still plans to a single
 * PUT — the bridge and the agent writes are paid for only when a reference
 * actually has to move.
 */
export function planRuntimeProfilesSave(input: {
  savedRuntimes: Record<string, RuntimeProfile>;
  draftRuntimes: Record<string, RuntimeProfile>;
  reassignments: RuntimeReassignments;
}): RuntimeSaveStep[] {
  const { savedRuntimes, draftRuntimes, reassignments } = input;
  const moves = Object.entries(reassignments);
  if (moves.length === 0) return [{ kind: 'runtimes', runtimes: draftRuntimes }];

  const steps: RuntimeSaveStep[] = [];
  if (moves.some(([, target]) => !savedRuntimes[target])) {
    steps.push({ kind: 'runtimes', runtimes: { ...savedRuntimes, ...draftRuntimes } });
  }
  for (const [agent, runtime] of moves) {
    steps.push({ kind: 'agent', agent, runtime, harness: draftRuntimes[runtime]?.harness });
  }
  steps.push({ kind: 'runtimes', runtimes: draftRuntimes });
  return steps;
}

/**
 * Build the agent block to PUT when the Runtime section's harness `Select`
 * changes. Pure so the two traps below are unit-testable without a DOM.
 *
 * Trap 1 — the PUT route rebuilds the whole `agents.<name>` governance block
 * from the request body (`agent-config.ts`'s `governanceRaw` spread), so a
 * bare `{ runtime }` would silently strip this agent's
 * connectors/secrets/skills/kortix_cli grants. The existing block must be
 * carried over.
 *
 * Trap 2 — only OpenCode has named sub-agents. Carrying `agent` across to a
 * brand harness writes a field it can't honor, so it's dropped. Mirrors the
 * agent editor's own rule (`agent-editor.tsx`).
 */
export function nextAgentBlockForRuntime(
  block: Record<string, unknown> | null | undefined,
  profileName: string,
  harness: AcpHarness | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(block ?? {}), runtime: profileName };
  if (harness !== 'opencode') delete next.agent;
  return next;
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
