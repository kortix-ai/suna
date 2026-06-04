/**
 * Kortix runtime feature control.
 *
 * The Kortix OpenCode runtime ships a set of built-in features on top of plain
 * OpenCode (memory, web tools, terminal, the `show` tool, the executor MCP).
 * Every feature is ON by default. Projects can change the defaults in
 * `kortix.toml` `[runtime]`, and a session can *enforce* an override at
 * session-create time (the override wins over the project default).
 *
 * The resolved state is injected into the sandbox as env vars; the daemon
 * forwards them to the OpenCode runtime, where the built-in tools self-gate
 * (see `.kortix/opencode/tools/lib/runtime-gate.ts`) and the daemon skips
 * injecting disabled platform pieces (e.g. the executor MCP).
 *
 *   [runtime]
 *   disable_all = false   # true → run as plain OpenCode (all built-ins off)
 *   memory      = true
 *   web_tools   = true
 *   pty         = true
 *   show        = true
 *   executor    = true
 */

/** The built-in runtime features that can be toggled. */
export const RUNTIME_FEATURES = ['memory', 'web_tools', 'pty', 'show', 'executor'] as const;
export type RuntimeFeature = (typeof RUNTIME_FEATURES)[number];

const FEATURE_SET = new Set<string>(RUNTIME_FEATURES);

/** A partial set of feature toggles, plus the master kill-switch. */
export interface RuntimeFlags {
  /** When true, ALL Kortix built-ins are off — the session runs as plain OpenCode. */
  disableAll?: boolean;
  /** Per-feature enable/disable. Omitted = inherit (default ON). */
  features?: Partial<Record<RuntimeFeature, boolean>>;
}

/** Fully-resolved runtime state: every feature has a concrete boolean. */
export interface EffectiveRuntime {
  disableAll: boolean;
  features: Record<RuntimeFeature, boolean>;
}

function coerceBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(s)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(s)) return false;
  }
  return undefined;
}

/**
 * Parse a `[runtime]` table (from `kortix.toml`, i.e. `manifest.raw.runtime`)
 * or a session-create `runtime` override body into normalized RuntimeFlags.
 * Unknown keys are ignored; non-boolean values are dropped. Accepts both
 * `disable_all` (TOML) and `disableAll` (JSON) spellings.
 */
export function parseRuntimeFlags(raw: unknown): RuntimeFlags {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const flags: RuntimeFlags = {};

  const disableAll = coerceBool(obj.disable_all ?? obj.disableAll);
  if (disableAll !== undefined) flags.disableAll = disableAll;

  const features: Partial<Record<RuntimeFeature, boolean>> = {};
  // Allow both a flat shape (`memory = false`) and a nested `features` table.
  const nested = obj.features && typeof obj.features === 'object' ? (obj.features as Record<string, unknown>) : {};
  for (const [key, value] of [...Object.entries(obj), ...Object.entries(nested)]) {
    if (!FEATURE_SET.has(key)) continue;
    const b = coerceBool(value);
    if (b !== undefined) features[key as RuntimeFeature] = b;
  }
  if (Object.keys(features).length > 0) flags.features = features;

  return flags;
}

/**
 * Resolve the effective runtime: defaults (all ON) ⊕ project `kortix.toml`
 * `[runtime]` ⊕ per-session override. Later layers win, so a session can
 * force a feature on or off regardless of the project default ("enforce").
 */
export function resolveEffectiveRuntime(
  projectFlags: RuntimeFlags | undefined,
  sessionOverride: RuntimeFlags | undefined,
): EffectiveRuntime {
  const layers = [projectFlags, sessionOverride].filter(Boolean) as RuntimeFlags[];

  let disableAll = false;
  const features = Object.fromEntries(RUNTIME_FEATURES.map((f) => [f, true])) as Record<RuntimeFeature, boolean>;

  for (const layer of layers) {
    if (layer.disableAll !== undefined) disableAll = layer.disableAll;
    if (layer.features) {
      for (const f of RUNTIME_FEATURES) {
        if (layer.features[f] !== undefined) features[f] = layer.features[f]!;
      }
    }
  }

  return { disableAll, features };
}

/**
 * The env vars to inject into the sandbox for this runtime. Mirrors the
 * contract the daemon forwards and the tools read. Only emits the flags that
 * deviate from the all-ON default, so an unconfigured project sets nothing
 * (identical to today's behavior).
 */
export function runtimeEnvVars(effective: EffectiveRuntime): Record<string, string> {
  const env: Record<string, string> = {};
  if (effective.disableAll) {
    env.KORTIX_RUNTIME_DISABLE_ALL = 'true';
    return env; // disable_all subsumes per-feature flags
  }
  for (const f of RUNTIME_FEATURES) {
    if (!effective.features[f]) env[`KORTIX_RUNTIME_${f.toUpperCase()}`] = 'off';
  }
  return env;
}

/** True when the executor MCP should NOT be injected for this runtime. */
export function executorDisabled(effective: EffectiveRuntime): boolean {
  return effective.disableAll || effective.features.executor === false;
}
