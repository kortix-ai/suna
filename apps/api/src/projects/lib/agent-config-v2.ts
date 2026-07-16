/**
 * Read/write helpers for the v2 `agents.<name>` GOVERNANCE block (spec
 * docs/specs/2026-07-05-agent-first-config-unification.md §2.2, redirected
 * 2026-07-05 — "one home per concern"). `AgentBlockV2` here is governance
 * ONLY: connectors/secrets/skills/kortix_cli/workspace/enabled. OpenCode
 * BEHAVIOR (mode/model/temperature/top_p/steps/variant/color/hidden/
 * permission/prompt) lives entirely in the agent's own native
 * `.kortix/opencode/agents/<name>.md` frontmatter + body — see
 * `./agent-markdown.ts` (parse/serialize) and `./compile-agent-config.ts`
 * (`agentMarkdownPath`, the conventional-path join). The dashboard's agent
 * editor route (`../routes/agent-config.ts`) is what merges this governance
 * half with the `.md` behavior half into one wire response/request — this
 * module only ever touches kortix.yaml.
 *
 * Distinct from `../agents.ts` (`AgentSpec` / `extractAgents`): that module
 * resolves the platform GRANT the session token carries (a narrower view —
 * connectors/secrets/kortix_cli reduced to the wire `AgentGrant` shape).
 * This module instead reads/writes the agent's declared governance block
 * verbatim so the editor can present (and persist) the complete governance
 * field space, not just the grant subset. Pure — no I/O; callers own
 * load/commit (mirrors `applyAgentScope` in `../agents.ts`).
 */
import {
  type AgentBlockV3,
  type AgentBlockV2,
  SLUG_RE,
  validateManifest,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import { HARNESSES } from '@kortix/shared/harnesses';
import type { ParsedManifest } from '../triggers';

/** Slug rule for an agent name — same as every other manifest slug. Reuses
 *  `@kortix/manifest-schema`'s exported `SLUG_RE` directly (it used to be
 *  re-derived here as a local copy under the mistaken assumption that the
 *  regex wasn't exported). */
export function isValidAgentName(name: string): boolean {
  return SLUG_RE.test(name);
}

export type ReadAgentBlockResult =
  | { ok: true; schemaVersion: number; block: AgentBlockV2 | null; defaultAgent: string | null }
  | { ok: false; error: string };

/**
 * Read one agent's raw v2 block out of an already-loaded manifest. Never
 * throws. `block` is `null` for a v1 manifest (schemaVersion !== 2) or when
 * the named agent isn't declared yet (a brand-new agent the editor is about
 * to create) — both are valid, non-error states the caller (the GET route)
 * surfaces distinctly via `schemaVersion`/`ok`.
 */
export function readAgentBlockV2(manifest: ParsedManifest, agentName: string): ReadAgentBlockResult {
  if (manifest.schemaVersion !== 2) {
    return { ok: true, schemaVersion: manifest.schemaVersion, block: null, defaultAgent: null };
  }
  const rawAgents = manifest.raw.agents;
  const defaultAgentRaw = manifest.raw.default_agent;
  const defaultAgent =
    typeof defaultAgentRaw === 'string' && defaultAgentRaw.trim() ? defaultAgentRaw.trim() : null;
  if (rawAgents === undefined || rawAgents === null) {
    return { ok: true, schemaVersion: 2, block: null, defaultAgent };
  }
  if (Array.isArray(rawAgents) || typeof rawAgents !== 'object') {
    return { ok: false, error: '`agents` is malformed in this manifest (expected a map).' };
  }
  const entry = (rawAgents as Record<string, unknown>)[agentName];
  if (entry === undefined) {
    return { ok: true, schemaVersion: 2, block: null, defaultAgent };
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: `agents.${agentName} is malformed (expected a table/object).` };
  }
  return { ok: true, schemaVersion: 2, block: entry as AgentBlockV2, defaultAgent };
}

export type ApplyAgentBlockResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string; issues?: ManifestIssue[] };

export type RuntimeProfileV3 = {
  harness: 'claude' | 'codex' | 'opencode' | 'pi';
  config_dir?: string;
};

// Config-dir values derive from the canonical `@kortix/shared` harness
// descriptor (do not re-hardcode them here); key/insertion order is pinned —
// WS1-P1-b tests assert this exact shape.
export const DEFAULT_RUNTIME_PROFILES_V3: Record<string, RuntimeProfileV3> = {
  opencode: { harness: 'opencode', config_dir: HARNESSES.opencode.configDir },
  claude: { harness: 'claude', config_dir: HARNESSES.claude.configDir },
  codex: { harness: 'codex', config_dir: HARNESSES.codex.configDir },
  pi: { harness: 'pi', config_dir: HARNESSES.pi.configDir },
};

/** Losslessly promote v2 governance to ACP-native v3 routing. Native OpenCode
 * behavior files remain untouched; every existing logical agent initially
 * keeps OpenCode while the other official harnesses become selectable. */
export function migrateManifestV2ToV3(manifest: ParsedManifest): ApplyAgentBlockResult {
  if (manifest.schemaVersion !== 2) {
    return { ok: false, error: 'Only a kortix_version 2 manifest can be upgraded to v3.' };
  }
  const rawAgents = manifest.raw.agents;
  if (!rawAgents || typeof rawAgents !== 'object' || Array.isArray(rawAgents)) {
    return { ok: false, error: '`agents` is malformed in this manifest (expected a map).' };
  }
  const agents = Object.fromEntries(
    Object.entries(rawAgents as Record<string, unknown>).map(([name, value]) => [
      name,
      { ...(value as Record<string, unknown>), runtime: 'opencode', agent: name },
    ]),
  );
  const { opencode: _legacyRuntime, ...rest } = manifest.raw;
  const nextRaw = {
    ...rest,
    kortix_version: 3,
    runtimes: DEFAULT_RUNTIME_PROFILES_V3,
    agents,
  };
  const result = validateManifest(nextRaw, manifest.format);
  const errorIssues = result.issues.filter((issue) => issue.severity === 'error');
  return errorIssues.length
    ? { ok: false, error: errorIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '), issues: errorIssues }
    : { ok: true, raw: nextRaw };
}

/** Replace the complete v3 runtime-profile map and validate every agent
 * reference against it before the caller commits the manifest. */
export function applyRuntimeProfilesV3(
  manifest: ParsedManifest,
  runtimes: Record<string, RuntimeProfileV3>,
): ApplyAgentBlockResult {
  if (manifest.schemaVersion !== 3) {
    return { ok: false, error: 'Runtime profiles require a kortix_version 3 manifest.' };
  }
  const nextRaw = { ...manifest.raw, runtimes };
  const result = validateManifest(nextRaw, manifest.format);
  const errorIssues = result.issues.filter((issue) => issue.severity === 'error');
  return errorIssues.length
    ? {
        ok: false,
        error: errorIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        issues: errorIssues,
      }
    : { ok: true, raw: nextRaw };
}

export type ReadAgentBlockV3Result =
  | {
      ok: true;
      schemaVersion: 3;
      block: AgentBlockV3 | null;
      defaultAgent: string | null;
      runtimes: Record<string, { harness: string; config_dir?: string }>;
    }
  | { ok: false; error: string };

export function readAgentBlockV3(
  manifest: ParsedManifest,
  agentName: string,
): ReadAgentBlockV3Result {
  if (manifest.schemaVersion !== 3) {
    return { ok: false, error: 'This project does not use a kortix_version 3 manifest.' };
  }
  const rawAgents = manifest.raw.agents;
  const rawRuntimes = manifest.raw.runtimes;
  if (!rawAgents || typeof rawAgents !== 'object' || Array.isArray(rawAgents)) {
    return { ok: false, error: '`agents` is malformed in this manifest (expected a map).' };
  }
  if (!rawRuntimes || typeof rawRuntimes !== 'object' || Array.isArray(rawRuntimes)) {
    return { ok: false, error: '`runtimes` is malformed in this manifest (expected a map).' };
  }
  const entry = (rawAgents as Record<string, unknown>)[agentName];
  if (entry !== undefined && (!entry || typeof entry !== 'object' || Array.isArray(entry))) {
    return { ok: false, error: `agents.${agentName} is malformed (expected a table/object).` };
  }
  const defaultAgent = typeof manifest.raw.default_agent === 'string'
    ? manifest.raw.default_agent.trim() || null
    : null;
  return {
    ok: true,
    schemaVersion: 3,
    block: (entry as AgentBlockV3 | undefined) ?? null,
    defaultAgent,
    runtimes: rawRuntimes as Record<string, { harness: string; config_dir?: string }>,
  };
}

export function applyAgentBlockV3(
  manifest: ParsedManifest,
  agentName: string,
  block: AgentBlockV3,
): ApplyAgentBlockResult {
  if (manifest.schemaVersion !== 3) {
    return { ok: false, error: 'This project does not use a kortix_version 3 manifest.' };
  }
  if (!isValidAgentName(agentName)) {
    return { ok: false, error: `"${agentName}" is not a valid agent name (lowercase letters, digits, dashes, underscores).` };
  }
  const rawAgents = manifest.raw.agents;
  if (!rawAgents || typeof rawAgents !== 'object' || Array.isArray(rawAgents)) {
    return { ok: false, error: '`agents` is malformed in this manifest (expected a map).' };
  }
  const nextRaw = {
    ...manifest.raw,
    agents: { ...(rawAgents as Record<string, unknown>), [agentName]: block },
  };
  const result = validateManifest(nextRaw, manifest.format);
  const errorIssues = result.issues.filter((issue) => issue.severity === 'error');
  return errorIssues.length
    ? {
        ok: false,
        error: errorIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        issues: errorIssues,
      }
    : { ok: true, raw: nextRaw };
}

/**
 * Change the project-wide default agent without touching any agent block.
 * The manifest validator is the authority: the target must be a declared,
 * enabled v2 agent before the caller is allowed to commit the file.
 */
export function applyDefaultAgentV2(
  manifest: ParsedManifest,
  agentName: string,
): ApplyAgentBlockResult {
  if (manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3) {
    return {
      ok: false,
      error:
        'This project uses a kortix_version 1 manifest. Upgrade to kortix.yaml to set a project default agent.',
    };
  }
  if (!isValidAgentName(agentName)) {
    return {
      ok: false,
      error: `"${agentName}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`,
    };
  }

  const nextRaw = { ...manifest.raw, default_agent: agentName };
  const result = validateManifest(nextRaw, manifest.format);
  const errorIssues = result.issues.filter((issue) => issue.severity === 'error');
  if (errorIssues.length > 0) {
    return {
      ok: false,
      error: errorIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      issues: errorIssues,
    };
  }
  return { ok: true, raw: nextRaw };
}

/**
 * Write one agent's full v2 block into the manifest's raw object (full
 * replace, upsert-by-name — same "read whole file, mutate one entry,
 * validate, commit" shape as `applyAgentScope`), and shape-validate the
 * RESULT through the real `validateManifest` before the caller commits —
 * a malformed permission tree, unknown enum, or ungrantable `kortix_cli`
 * action is a clean rejection here, never a broken manifest on disk.
 *
 * Refuses outright on a v1 manifest — the full v2 field space (permission
 * trees, per-field governance) has no v1 representation to fall back to;
 * the caller degrades in the UI instead of ever reaching this function for
 * a v1 project (see docs/specs/2026-07-05-agent-first-config-unification.md
 * §2.7 — v2-only feature).
 */
export function applyAgentBlockV2(
  manifest: ParsedManifest,
  agentName: string,
  block: AgentBlockV2,
): ApplyAgentBlockResult {
  if (manifest.schemaVersion !== 2) {
    return {
      ok: false,
      error:
        'This project uses a kortix_version 1 manifest. Upgrade to kortix_version 2 (kortix.yaml) to edit the full agent configuration.',
    };
  }
  if (!isValidAgentName(agentName)) {
    return {
      ok: false,
      error: `"${agentName}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`,
    };
  }
  const rawAgents = manifest.raw.agents;
  if (rawAgents !== undefined && rawAgents !== null && (Array.isArray(rawAgents) || typeof rawAgents !== 'object')) {
    return { ok: false, error: '`agents` is malformed in this manifest (expected a map).' };
  }
  const nextAgents: Record<string, unknown> = { ...(rawAgents as Record<string, unknown> | undefined) };
  nextAgents[agentName] = block;
  const nextRaw = { ...manifest.raw, agents: nextAgents };

  const result = validateManifest(nextRaw, manifest.format);
  const errorIssues = result.issues.filter((i) => i.severity === 'error');
  if (errorIssues.length > 0) {
    return {
      ok: false,
      error: errorIssues.map((i) => `${i.path}: ${i.message}`).join('; '),
      issues: errorIssues,
    };
  }
  return { ok: true, raw: nextRaw };
}

/**
 * Apply a secrets/connectors SCOPE edit to a v2 `agents:` MAP manifest — the v2
 * counterpart of `applyAgentScope` in `../agents.ts` (which only handles the v1
 * `[[agents]]` array and would treat a v2 map as an empty array → "agent not
 * found"). Reads the agent's existing governance block, merges in JUST the two
 * scope grants, and reuses `applyAgentBlockV2` for the upsert + `validateManifest`
 * gate (so every other governance field on the block is preserved verbatim).
 *
 * Two v2 semantics the v1 path gets wrong: (1) v1's wire `env` is v2's `secrets`
 * key; (2) v2 is deny-by-default, so a none/`[]` selection is written by OMITTING
 * the key (matching hand-authored kortix.yaml), NOT by v1's env-default-is-'all'
 * omit rule. `notFound` distinguishes "agent not declared" (route → 404) from a
 * validation failure (route → 400) — this path scopes an existing agent, it
 * never creates one.
 */
export function applyAgentScopeV2(
  manifest: ParsedManifest,
  agentName: string,
  scope: { env?: string[] | 'all'; connectors?: string[] | 'all' },
): ApplyAgentBlockResult & { notFound?: boolean } {
  const rawAgents = manifest.raw.agents;
  const existing =
    rawAgents && typeof rawAgents === 'object' && !Array.isArray(rawAgents)
      ? (rawAgents as Record<string, unknown>)[agentName]
      : undefined;
  if (existing === undefined || existing === null) {
    return {
      ok: false,
      notFound: true,
      error: `No agent "${agentName}" declared in ${manifest.path || 'kortix.yaml'}`,
    };
  }
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    return { ok: false, error: `agents.${agentName} is malformed (expected a table/object).` };
  }
  const merged: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
  if (scope.env !== undefined) {
    if (scope.env === 'all') merged.secrets = 'all';
    else if (scope.env.length === 0) delete merged.secrets;
    else merged.secrets = scope.env;
  }
  if (scope.connectors !== undefined) {
    if (scope.connectors === 'all') merged.connectors = 'all';
    else if (scope.connectors.length === 0) delete merged.connectors;
    else merged.connectors = scope.connectors;
  }
  return applyAgentBlockV2(manifest, agentName, merged as AgentBlockV2);
}
