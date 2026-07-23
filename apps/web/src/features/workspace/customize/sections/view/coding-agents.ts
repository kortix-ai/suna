/**
 * "Coding agents" — the product-facing view of a v3 manifest's `runtimes:` map.
 *
 * The manifest models this as NAMED RUNTIME PROFILES: `runtimes: { <name>:
 * { harness, config_dir } }`, and each logical agent points at one by name
 * (`agents.<agent>.runtime`). That indirection exists so one project could
 * declare two setups on the same harness (say two OpenCode profiles reading
 * different config folders) — real, but rare, and it costs every user a
 * "name your thing before you can pick your thing" step in the common case.
 *
 * So the UI inverts it: ONE ROW PER HARNESS (Claude Code, Codex, OpenCode,
 * Pi), on or off. The profile name becomes an implementation detail this
 * module derives — turning a harness on writes a profile keyed by the harness
 * id, turning it off drops every profile pointing at it. Projects that really
 * do have two profiles on one harness still render as a single row; the extras
 * surface under Advanced (`extraProfileNames`) rather than being hidden or
 * clobbered.
 *
 * Pure map-in/map-out on purpose — no React, no queries — so the rules that
 * actually matter (what's in use, what can be turned off, what a removal would
 * throw away) are unit-testable without a DOM.
 */

import type { AcpHarness, RuntimeProfile } from '@kortix/sdk/projects-client';

import {
  ACP_HARNESSES,
  ACP_HARNESS_CONFIG_DIRS,
  ACP_HARNESS_LABELS,
} from './runtime-profile-options';

/**
 * One line per harness explaining what you'd be turning on, in terms of what
 * the user has to supply rather than how it's wired. Each claim is grounded in
 * that harness's `authKinds` in the canonical descriptor
 * (`packages/shared/src/harnesses.ts`) — not marketing, and deliberately not
 * the SDK's `harnessPresentation().description`, which says "coding harness,
 * connected over ACP" (accurate, and meaningless to anyone who doesn't already
 * know what ACP is).
 */
export const CODING_AGENT_BLURBS: Record<AcpHarness, string> = {
  claude: 'By Anthropic. Uses your Claude subscription or an Anthropic key.',
  codex: 'By OpenAI. Uses your ChatGPT subscription or an OpenAI key.',
  opencode: 'Open source. Works with any model you have connected.',
  pi: 'Lightweight. Works with any model you have connected.',
};

/**
 * The one-or-two-word version of the blurb, shown inline beside the name so a
 * row stays a single line (the blurb becomes its hover card). Enough to tell
 * the four apart at a glance without reading four sentences.
 */
export const CODING_AGENT_MAKERS: Record<AcpHarness, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  opencode: 'Open source',
  pi: 'Lightweight',
};

/** One agent as this module needs to see it — the subset of
 *  `ProjectConfigSummary['agents'][number]` that decides harness usage. */
export interface CodingAgentUsage {
  name: string;
  /** The manifest profile this agent selected (v3 `agents.<name>.runtime`). */
  runtime?: string | null;
  /** The harness the compiler resolved for it. */
  harness?: AcpHarness | null;
  enabled?: boolean;
}

export interface CodingAgentRow {
  harness: AcpHarness;
  label: string;
  /** Short inline qualifier ("Anthropic"), shown beside the label. */
  maker: string;
  /** Full sentence, shown on hover. */
  blurb: string;
  /** The profile that provides this harness, or `null` when it's turned off.
   *  This is what an agent's `runtime` field must be set to. */
  profileName: string | null;
  /** Additional profiles on the same harness. Almost always empty; when it
   *  isn't, Advanced is the only place that says so. */
  extraProfileNames: string[];
  /** Agents that would break if this harness were removed. Non-empty ⇒ the
   *  toggle is locked, because the server rejects the save anyway
   *  (`validateManifestCrossRefsV3`: "references undeclared runtime"). */
  usedBy: string[];
  /** True when the project's default agent runs on this harness. */
  isDefault: boolean;
  enabled: boolean;
}

/** Every profile pointing at `harness`, in declaration order. */
function profilesFor(runtimes: Record<string, RuntimeProfile>, harness: AcpHarness): string[] {
  return Object.entries(runtimes)
    .filter(([, profile]) => profile.harness === harness)
    .map(([name]) => name);
}

/**
 * The four official harnesses as toggleable rows, in the canonical order
 * (`HARNESS_IDS` — stable and meaningful for presentation, per the descriptor).
 * Always returns all four, whether or not the project declared them: the row
 * IS the way to turn one on, so a missing harness has to be visible.
 */
export function buildCodingAgentRows({
  runtimes,
  agents,
  defaultAgentName,
}: {
  runtimes: Record<string, RuntimeProfile>;
  agents: readonly CodingAgentUsage[];
  defaultAgentName: string | null;
}): CodingAgentRow[] {
  const defaultAgent = defaultAgentName
    ? agents.find((agent) => agent.name === defaultAgentName)
    : undefined;

  return ACP_HARNESSES.map((harness) => {
    const names = profilesFor(runtimes, harness);
    const [profileName = null, ...extraProfileNames] = names;
    return {
      harness,
      label: ACP_HARNESS_LABELS[harness],
      maker: CODING_AGENT_MAKERS[harness],
      blurb: CODING_AGENT_BLURBS[harness],
      profileName,
      extraProfileNames,
      usedBy: agents.filter((agent) => usesHarness(agent, names, harness)).map((a) => a.name),
      isDefault: Boolean(defaultAgent && usesHarness(defaultAgent, names, harness)),
      enabled: profileName !== null,
    };
  });
}

/**
 * Whether an agent runs on this harness. Prefers the explicit profile
 * reference (the thing the manifest validator actually checks) and falls back
 * to the compiler-resolved harness for agents that never named one — a
 * runtime-discovered agent isn't governed by `agents:`, so nothing would 400
 * on removal, but it would still stop working. We count it, because blocking a
 * removal that's merely inconvenient beats allowing one that silently breaks a
 * working agent.
 */
function usesHarness(
  agent: CodingAgentUsage,
  profileNames: string[],
  harness: AcpHarness,
): boolean {
  if (agent.runtime) return profileNames.includes(agent.runtime);
  return agent.harness === harness;
}

/** A profile key that doesn't collide with one already declared. */
function freeProfileName(runtimes: Record<string, RuntimeProfile>, base: string): string {
  if (!runtimes[base]) return base;
  let n = 2;
  while (runtimes[`${base}-${n}`]) n += 1;
  return `${base}-${n}`;
}

/**
 * Turn a harness on. Names the profile after the harness itself so the manifest
 * reads as `runtimes: { claude: { harness: claude } }` — the indirection is
 * still there for anyone editing the YAML by hand, it just stops being a
 * decision. No-ops when the harness is already available.
 */
export function enableCodingAgent(
  runtimes: Record<string, RuntimeProfile>,
  harness: AcpHarness,
): Record<string, RuntimeProfile> {
  if (profilesFor(runtimes, harness).length > 0) return runtimes;
  return {
    ...runtimes,
    [freeProfileName(runtimes, harness)]: {
      harness,
      config_dir: ACP_HARNESS_CONFIG_DIRS[harness],
    },
  };
}

/** Turn a harness off — drops every profile pointing at it. Callers must check
 *  `usedBy` first; this function does not police references. */
export function disableCodingAgent(
  runtimes: Record<string, RuntimeProfile>,
  harness: AcpHarness,
): Record<string, RuntimeProfile> {
  const next: Record<string, RuntimeProfile> = {};
  for (const [name, profile] of Object.entries(runtimes)) {
    if (profile.harness !== harness) next[name] = profile;
  }
  return next;
}

/**
 * Why a row's toggle is locked, as the sentence to show — `null` when it's
 * free to move. Ordered most-specific first so the reason a user sees is the
 * one they can act on.
 */
export function toggleBlockedReason(
  row: CodingAgentRow,
  rows: readonly CodingAgentRow[],
): string | null {
  if (!row.enabled) return null;
  if (row.usedBy.length > 0) {
    const [first, ...rest] = row.usedBy;
    const who = rest.length === 0 ? first : `${first} and ${rest.length} more`;
    return `${who} ${rest.length === 0 ? 'runs' : 'run'} on ${row.label}. Move ${rest.length === 0 ? 'it' : 'them'} to another coding agent first.`;
  }
  if (rows.filter((r) => r.enabled).length <= 1) {
    return 'This is the only coding agent left. Turn another one on first.';
  }
  return null;
}

/**
 * Whether turning this harness off would throw away hand-authored detail — a
 * renamed profile, or a config folder that isn't the harness default. Drives
 * whether the toggle confirms first: removing a plain `{ harness }` profile is
 * one click to undo and needs no ceremony, but silently discarding someone's
 * custom `config_dir` does.
 */
export function removalLosesCustomSetup(
  runtimes: Record<string, RuntimeProfile>,
  harness: AcpHarness,
): boolean {
  return Object.entries(runtimes).some(
    ([name, profile]) =>
      profile.harness === harness &&
      (name !== harness ||
        (profile.config_dir !== undefined &&
          profile.config_dir !== ACP_HARNESS_CONFIG_DIRS[harness])),
  );
}
