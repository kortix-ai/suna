/**
 * Permission-mode defaulting for a live ACP session.
 *
 * Product intent (owner, 2026-07-22): a fresh session should be FRICTIONLESS —
 * the agent auto-executes everything in its isolated sandbox and NEVER prompts
 * for per-tool permission by default. The user OPTS IN to a stricter,
 * prompts-you mode via the composer's mode pill; that opt-in is what
 * `explicitValue` carries here (persisted per-agent by the web layer).
 *
 * This module is the harness-neutral, framework-free core: given a session's
 * advertised `mode` config option, decide which advertised value to select at
 * session start (or when the "Allow everything" action fires). It NEVER invents
 * a mode id a harness doesn't advertise — every candidate is intersected with
 * the option's own `options` list first.
 *
 * The exact per-harness mode ids come from real captured envelopes
 * (`kortix.acp_session_envelopes`, local DB, 2026-07-22):
 *
 *  - claude (claude-agent-acp): `default` (Manual, prompts) / `acceptEdits` /
 *    `plan` / `dontAsk` / `auto`, plus `bypassPermissions` ("Bypass all
 *    permission checks", auto-allows every tool with zero prompts) — the last
 *    is only ADVERTISED when the adapter runs with `IS_SANDBOX=1`
 *    (`ALLOW_BYPASS = !IS_ROOT || IS_SANDBOX`; the sandbox runs it as root, so
 *    the launch env must set it — see `harness-registry.ts`).
 *  - codex (codex-acp): `read-only` (prompts) / `agent` (runs commands) /
 *    `agent-full-access` (adds network + out-of-workspace).
 *  - opencode: `mode` is an AGENT PERSONA selector (`build` / `plan` / project
 *    agents like `kortix`), NOT a permission level — deliberately excluded from
 *    the permissive order below so we never silently swap the user's chosen
 *    persona.
 *  - pi: advertises no permission-mode option today.
 */

import type { AcpSessionConfigOption } from './types';

/**
 * Advertised mode values ranked most-permissive first, across every harness
 * that exposes a real PERMISSION mode. Selection intersects this with what the
 * live session actually advertises and picks the first hit — so the same
 * "bypass everything" intent maps to `bypassPermissions` on Claude and
 * `agent-full-access` on Codex without a per-harness branch here.
 *
 * The ids are disjoint across harnesses (no value collides between Claude and
 * Codex), so one flat order is unambiguous. `acceptEdits`/`agent` are the
 * next-best fallbacks when the top mode isn't advertised (e.g. a Claude adapter
 * launched WITHOUT `IS_SANDBOX`, which then never offers `bypassPermissions`).
 *
 * Opencode personas (`build`/`kortix`/…) are intentionally absent — auto-
 * selecting `build` would clobber a user who launched the session on a
 * different persona.
 */
export const PERMISSIVE_MODE_VALUE_ORDER: readonly string[] = [
  'bypassPermissions', // claude — auto-allow every tool, no prompts
  'agent-full-access', // codex — full access incl. network + out-of-workspace
  'agent', // codex — read/edit files and run commands (fallback under full-access)
  'acceptEdits', // claude — auto-accept edits (fallback when bypass isn't offered)
];

/**
 * The harness-native STARTING modes that prompt the user (or are the plain
 * default) — the only current values we're willing to silently upgrade away
 * from. If a session's current mode is anything ELSE (the user already picked
 * `plan`, `acceptEdits`, a stricter mode, or the permissive target itself), the
 * default logic leaves it alone. Evidence: claude fresh session starts at
 * `default`, codex at `agent`.
 */
export const UPGRADEABLE_DEFAULT_MODE_VALUES: ReadonlySet<string> = new Set(['default', 'agent']);

/** `id === 'mode'` OR `category === 'mode'` — the session's permission/agent
 *  mode option, however a harness tags it. */
export function isAcpModeConfigOption(option: AcpSessionConfigOption): boolean {
  return option.id === 'mode' || option.category === 'mode';
}

export function findAcpModeConfigOption(
  options: readonly AcpSessionConfigOption[],
): AcpSessionConfigOption | null {
  return options.find(isAcpModeConfigOption) ?? null;
}

/** The selectable `value` (falling back to `id`) of each advertised choice, as
 *  strings — the identity space `setConfigOption`/`currentValue` compare in. */
export function modeOptionValues(option: AcpSessionConfigOption): string[] {
  return (option.options ?? []).map((choice, index) =>
    String(choice.value ?? choice.id ?? index),
  );
}

/**
 * The most-permissive mode this option actually advertises, or `null` when it
 * advertises none of the known permission modes (opencode/pi, or an unknown
 * adapter) — in which case no default should be forced.
 */
export function pickMostPermissiveMode(option: AcpSessionConfigOption | null): string | null {
  if (!option) return null;
  const advertised = new Set(modeOptionValues(option));
  for (const value of PERMISSIVE_MODE_VALUE_ORDER) {
    if (advertised.has(value)) return value;
  }
  return null;
}

/**
 * The single decision the session-start applier and the "Allow everything"
 * action both use: the advertised mode value to send via
 * `session/set_config_option`, or `null` for "do nothing".
 *
 * Precedence:
 *  1. A persisted EXPLICIT user choice for this agent wins outright — if it's
 *     still advertised, ensure the session is in it (return it when the current
 *     value differs, else `null`). Never overridden by the permissive default.
 *  2. Otherwise apply the most-permissive advertised mode — but ONLY when the
 *     session is still sitting in a harness-native "asks you / default" mode
 *     (`UPGRADEABLE_DEFAULT_MODE_VALUES`). This avoids stomping a mode the user
 *     picked pre-session, and is a no-op once already permissive.
 */
export function resolveDefaultModeToApply(input: {
  option: AcpSessionConfigOption | null;
  /** Persisted per-agent explicit mode choice, if any. */
  explicitValue?: string | null;
}): string | null {
  const { option, explicitValue } = input;
  if (!option) return null;
  const advertised = new Set(modeOptionValues(option));
  if (advertised.size === 0) return null;
  const current = String(option.currentValue ?? '');

  if (explicitValue && advertised.has(explicitValue)) {
    return explicitValue === current ? null : explicitValue;
  }

  const target = pickMostPermissiveMode(option);
  if (!target || target === current) return null;
  if (!UPGRADEABLE_DEFAULT_MODE_VALUES.has(current)) return null;
  return target;
}
