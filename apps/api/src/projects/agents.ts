/**
 * `[[agents]]` parsing for `kortix.toml`.
 *
 * An agent's *behavior* still comes from its OpenCode `.md` (front matter:
 * prompt/model/mode/tools/permission/skill-perms). Once a project declares
 * `[[agents]]`, this block is also the server-side launch roster and the
 * governance policy keyed by agent name. Its grant fields cover the two things
 * the agent `.md` can't express:
 *
 *   1. `connectors` — which integration profiles (by [[connectors]].slug) the
 *      agent may call. Default: none.
 *   2. `kortix_cli` — what the agent may do to Kortix itself via the `kortix`
 *      CLI/API (project-scoped iam actions: deploy, open CRs, triggers, …).
 *      Default: none. Account-scoped admin actions are NEVER grantable.
 *
 * The effective grant at session birth is `declared ∩ launching-user role`
 * (agent ≤ human). The default `kortix` agent is granted everything (`"all"`),
 * which ∩ the user = exactly the user's own permissions.
 *
 * Example:
 *
 *   [[agents]]
 *   name = "kortix"                       # default GP agent — connectors/kortix_cli = "all" (∩ user)
 *
 *   [[agents]]
 *   name       = "release-bot"
 *   connectors = ["github"]               # which integration profiles
 *   kortix_cli = ["project.deploy", "project.cr.open"]   # Kortix CLI/API powers
 *
 * Parser mirrors `projects/connectors.ts`: never throws on a bad entry, collects
 * them in `errors` so the UI can render them next to the good ones.
 */
import { createHash } from 'node:crypto';
import type { ParsedManifest } from './triggers';
import { PROJECT_ACTIONS, VALID_ACTIONS } from '../iam/actions';
import type { GitBackedProject } from './git';
import type { AgentGrant } from '@kortix/db';
import { resolveGrantSet, type GrantSetV2 } from '@kortix/manifest-schema';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MANIFEST_FILENAME = 'kortix.toml';

/**
 * The non-binding agent sentinel. `project_sessions.agent_name` defaults to this
 * literal and NO agent is ever named `default` — the runtime resolves it to
 * OpenCode's configured `default_agent` (a general-purpose agent). Kept in sync
 * with the proxy's copy (sandbox-proxy/routes/preview.ts).
 * See docs/specs/2026-06-28-token-session-agent-identity.md.
 */
export const DEFAULT_AGENT_SENTINEL = 'default';

/**
 * The actions an agent's `kortix_cli` may grant — the project-scoped surface.
 * Account-scoped admin actions (member.*, billing.*, token.*, project.create, …)
 * are deliberately excluded: they're the hard ceiling and can never be granted
 * to an agent. CR actions live in PROJECT_ACTIONS. The channel.* resource
 * actions (channel.send, …) were removed from the catalog (IAM enforcement
 * audit): they were never wired to any route, so granting them did nothing —
 * see iam/actions.ts.
 */
export const GRANTABLE_KORTIX_CLI: ReadonlySet<string> = new Set([
  ...Object.values(PROJECT_ACTIONS),
]);

/** Sorted list for `kortix validate` / error messages / the UI picker. */
export const GRANTABLE_KORTIX_CLI_LIST: readonly string[] = [...GRANTABLE_KORTIX_CLI].sort();

/** `"all"` = every grantable action / every project connector (capped at the user). */
export type GrantSet = string[] | 'all';

export interface AgentSpec {
  /** Agent name — unique per project. Matches projectSessions.agentName + the `.md` filename. */
  name: string;
  /** `kortix.toml#agents.<name>` for UI / error reporting. */
  path: string;
  /** When false the overlay is skipped (the agent still runs from its `.md`, with default-deny scope). */
  enabled: boolean;
  /** Which connector profiles (by slug) this agent may use. `[]` = none (default). */
  connectors: GrantSet;
  /** Kortix CLI/API powers (project-scoped iam actions). `[]` = none (default). */
  kortixCli: GrantSet;
  /** Project-secret names this agent receives as sandbox env + may read via the
   *  secrets API. `'all'` = every secret the launching user can see (default when
   *  the `env` key is omitted — a NEW dimension, so omitting it must not starve
   *  existing agents); an explicit list narrows it; `[]` = none. */
  env: GrantSet;
  /** Optional behavior-file path override (defaults to the conventional `.md` by name). */
  file: string | null;
  /**
   * The agent's declarative default model (wire form `provider/model`), or null
   * for "Default" — resolve project → account → platform (`auto`). A
   * `model_preferences` row (scope=agent), set via the SDK/UI, overrides this at
   * run time without a code commit. Catalog-availability is validated at the
   * route/resolver layer (the parser stays catalog-free), same as everywhere the
   * gateway is the source of truth for entitlement.
   */
  model: string | null;
}

export interface AgentParseError {
  name: string;
  path: string;
  error: string;
}

export interface LoadedAgents {
  specs: AgentSpec[];
  errors: AgentParseError[];
  /**
   * The manifest's own top-level `default_agent` (v2 only — `ManifestV2` in
   * `@kortix/manifest-schema`; v1 has no such field, so this is always `null`
   * for a v1 manifest). Lets grant resolution make the non-binding `"default"`
   * sentinel resolve to a concrete declared agent's grant for a v2 project,
   * instead of falling back to the permissive `null` (unrestricted) v1
   * behavior — see `grantFromLoadedAgents` (spec §2.1).
   */
  defaultAgent?: string | null;
}

/**
 * Pull the manifest's agent declarations out of a parsed manifest. Never
 * throws. Dispatches on the manifest's OWN declared `kortix_version` (not
 * shape-sniffing `raw.agents`) so a malformed v1 manifest that happens to
 * write `agents` as an object still gets the v1 "must be an array" error
 * instead of silently routing into the v2 reader:
 *   - v1: `[[agents]]` — an array of tables (existing behavior, unchanged).
 *   - v2: `agents:` — a name → block map (spec §2.1/§2.2); see
 *     `extractAgentsV2`.
 */
export function extractAgents(manifest: ParsedManifest): LoadedAgents {
  const filename = manifest.path || MANIFEST_FILENAME;
  const raw = manifest.raw.agents;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [], defaultAgent: null };
  }

  if (manifest.schemaVersion >= 2) {
    return extractAgentsV2(raw, manifest, filename);
  }

  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [{
        name: '(top-level)',
        path: filename,
        error: '`agents` must be an array of tables — use [[agents]], not [agents]',
      }],
      defaultAgent: null,
    };
  }

  const specs: AgentSpec[] = [];
  const errors: AgentParseError[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const result = parseAgentEntry(entry, index, filename);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    if (seen.has(result.spec.name)) {
      errors.push({
        name: result.spec.name,
        path: result.spec.path,
        error: `Duplicate agent name "${result.spec.name}" — names must be unique within a project`,
      });
      return;
    }
    seen.add(result.spec.name);
    specs.push(result.spec);
  });

  specs.sort((a, b) => a.name.localeCompare(b.name));
  errors.sort((a, b) => a.name.localeCompare(b.name));
  return { specs, errors, defaultAgent: null };
}

/**
 * v2's `agents:` map reader (spec §2.1/§2.2). Maps each `AgentBlockV2` onto
 * the same `AgentSpec` shape the rest of the grant pipeline already consumes:
 *   - `connectors` / `kortix_cli` / `secrets` (v2's rename of v1's `env`) are
 *     resolved via `resolveGrantSet` with v2's deny-by-default default
 *     (an omitted grant → `'none'`), the opposite of v1's `env: 'all'`
 *     back-compat default.
 *   - `enabled` comes from `!disable` (OpenCode's own passthrough flag).
 *   - `file` comes from `prompt` (the behavior-file reference).
 * Never throws — a bad entry lands in `errors`, same contract as v1.
 */
function extractAgentsV2(raw: unknown, manifest: ParsedManifest, filename: string): LoadedAgents {
  if (Array.isArray(raw) || typeof raw !== 'object') {
    return {
      specs: [],
      errors: [{
        name: '(top-level)',
        path: filename,
        error:
          '`agents` must be a map of agent name → agent block in kortix_version 2 (the v1 `[[agents]]` array becomes a map)',
      }],
      defaultAgent: null,
    };
  }

  const specs: AgentSpec[] = [];
  const errors: AgentParseError[] = [];

  for (const [name, block] of Object.entries(raw as Record<string, unknown>)) {
    const result = parseAgentEntryV2(name, block, filename);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    specs.push(result.spec);
  }

  specs.sort((a, b) => a.name.localeCompare(b.name));
  errors.sort((a, b) => a.name.localeCompare(b.name));

  const defaultAgentRaw = manifest.raw.default_agent;
  const defaultAgent =
    typeof defaultAgentRaw === 'string' && defaultAgentRaw.trim() ? defaultAgentRaw.trim() : null;

  return { specs, errors, defaultAgent };
}

/**
 * Read + parse a project's manifest, then extract `[[agents]]`. Never throws.
 */
export async function loadProjectAgents(project: GitBackedProject): Promise<LoadedAgents> {
  let manifest: ParsedManifest | null;
  try {
    const { readManifest } = await import('./triggers');
    manifest = await readManifest(project);
  } catch (err) {
    // The manifest failed to parse before we learned which candidate file it
    // actually was (.yaml/.yml/.toml) — fall back to the project's configured
    // manifestPath (best-effort; may be stale for a project that switched
    // format by hand without updating it) rather than always naming kortix.toml.
    return {
      specs: [],
      errors: [{
        name: '(manifest)',
        path: project.manifestPath || MANIFEST_FILENAME,
        error: (err as Error).message || 'Failed to read manifest',
      }],
      defaultAgent: null,
    };
  }
  if (!manifest) return { specs: [], errors: [], defaultAgent: null };
  return extractAgents(manifest);
}

/**
 * Resolve the per-agent grant to stamp onto a session token at birth.
 *
 * Backward-compatible + secure-on-adoption:
 *   - Manifest declares NO `[[agents]]` at all → returns `null` (no restriction;
 *     full access, capped at the launching user by the route's own role check).
 *     Every existing project keeps working exactly as today.
 *   - Agent IS listed → its declared overlay (connectors + kortix_cli).
 *   - Project adopted `[[agents]]` but the agent is NOT listed → default-DENY
 *     (the agent still runs its `.md` behavior, but with no connectors and no
 *     Kortix-CLI powers).
 *
 * The `∩ launching-user role` is NOT applied here — it's enforced for free at
 * the route layer (the account token resolves to the user, whose role is
 * already checked), so the grant carries the *declared* set. Net effect at a
 * route = userRole ∩ agentGrant.
 */
export async function resolveAgentGrant(
  agentName: string,
  project: GitBackedProject,
): Promise<AgentGrant | null> {
  return grantFromLoadedAgents(agentName, await loadProjectAgents(project));
}

/** Pure resolution rule (no I/O) — see `resolveAgentGrant`. Exported for tests. */
export function grantFromLoadedAgents(agentName: string, loaded: LoadedAgents): AgentGrant | null {
  // No [[agents]] section parsed and no errors → project hasn't adopted
  // per-agent governance → no restriction (today's behavior).
  if (loaded.specs.length === 0 && loaded.errors.length === 0) return null;

  const spec = loaded.specs.find((s) => s.name === agentName && s.enabled);
  if (spec) {
    return { agent: agentName, kortixCli: spec.kortixCli, connectors: spec.connectors, env: spec.env };
  }

  // The `default` sentinel is non-binding for v1: no agent is ever named
  // `default`, so a `default`-booted session is OpenCode's configured
  // `default_agent` (a general-purpose agent, conventionally `kortix`, granted
  // "all") — NOT an unlisted concrete agent. Default-denying it stripped EVERY
  // connector from such sessions (the `kortix executor connectors` → [] bug,
  // and synthetic channel/computer connectors never reaching the agent) even
  // though OpenCode runs them as the fully-privileged default agent. Resolve
  // it the way the proxy already does: non-binding → null (no restriction,
  // still capped at the launching user's role; identical to a project that
  // never adopted [[agents]]).
  //
  // v2 CHANGES this: the manifest declares a top-level `default_agent` that
  // MUST always resolve to a concrete declared agent (spec §2.1 — "closes
  // trigger seam 7(a) structurally"). `loaded.defaultAgent` is only ever
  // non-null for a v2 manifest (see `extractAgentsV2`), so this branch is a
  // pure v2 addition — a v1 project (defaultAgent always null) falls straight
  // through to the unchanged `return null` below.
  if (agentName === DEFAULT_AGENT_SENTINEL) {
    if (loaded.defaultAgent) {
      const declared = loaded.specs.find((s) => s.name === loaded.defaultAgent && s.enabled);
      if (declared) {
        return {
          agent: loaded.defaultAgent,
          kortixCli: declared.kortixCli,
          connectors: declared.connectors,
          env: declared.env,
        };
      }
    }
    // A project locks down its default by setting `default_agent` to a
    // CONCRETE declared agent, which reaches us by that name and gets its
    // (possibly narrow) grant — so this never weakens an intentionally-
    // restricted default. Falling through here means either v1 (no
    // manifest-level default_agent to honor) or a v2 manifest whose declared
    // default_agent doesn't resolve to an enabled spec (a validation-time
    // error the CR-merge gate should already have caught).
    return null;
  }

  // Governance adopted but this concrete agent is unlisted → default-deny
  // everything, including secrets/env (an unlisted agent receives no project
  // secrets).
  return { agent: agentName, kortixCli: [], connectors: [], env: [] };
}

/**
 * Is this project subject to MANDATORY DECLARED AGENTS enforcement?
 * (docs/specs/2026-07-05-agent-first-config-unification.md §2.1/§3 Phase 2)
 *
 * There is no per-project flag store yet, so subjectness is:
 *   the platform-wide flag OR `project.metadata.require_declared_agents === true`.
 * New projects stamp the metadata flag at creation (see POST /projects/provision);
 * pre-existing projects stay non-subject (and therefore behave exactly as before)
 * until the platform flag flips or they're explicitly migrated.
 */
export function projectRequiresDeclaredAgents(
  projectMetadata: unknown,
  platformFlag: boolean,
): boolean {
  if (platformFlag) return true;
  if (!projectMetadata || typeof projectMetadata !== 'object') return false;
  return (projectMetadata as Record<string, unknown>).require_declared_agents === true;
}

/** A session/trigger was rejected outright because the project requires
 *  declared agents and the requested identity doesn't resolve to one. */
export interface AgentNotDeclaredError {
  ok: false;
  error: string;
  code: 'AGENT_NOT_DECLARED';
}

export type GovernedAgentGrantResult = { ok: true; grant: AgentGrant | null } | AgentNotDeclaredError;

/**
 * Resolve the per-agent grant when the project MAY be subject to mandatory
 * declared agents. Pure (no I/O) — mirrors `grantFromLoadedAgents` for the
 * non-subject case exactly (same lookup, same fallback, byte-for-byte
 * unchanged behavior), so a non-subject project is provably unaffected.
 *
 * When subject:
 *   - a concrete agent name not declared (or disabled) in `[[agents]]` is
 *     REJECTED with an explicit error — never silently resolved to the
 *     permissive null grant `grantFromLoadedAgents` would return for an
 *     ungoverned project, and never silently default-denied-to-running either.
 *   - the `default` sentinel must resolve to the project's declared
 *     `default_agent`; a project with no `default_agent` configured, or one
 *     that doesn't name a declared/enabled agent, is rejected the same way —
 *     this is what closes trigger/spec seam 7(a) structurally (§2.1).
 *     `opts.projectDefaultAgent` (the DB `project.metadata.default_agent`
 *     mirror callers pass in) wins when set; `loaded.defaultAgent` (the v2
 *     manifest's own top-level `default_agent` — always null for v1) is the
 *     fallback, so a v2 project that never separately configured the DB-side
 *     field still resolves the sentinel to what it actually declared in git.
 *
 * Exported for tests. Callers needing the historical `AgentGrant | null`
 * behavior unconditionally should keep using `grantFromLoadedAgents` /
 * `resolveAgentGrant` directly (e.g. the sandbox token mint, which must
 * never widen on a manifest-read hiccup — see session-sandbox.ts).
 */
export function resolveGovernedAgentGrant(
  agentName: string,
  loaded: LoadedAgents,
  opts: { subject: boolean; projectDefaultAgent: string | null },
): GovernedAgentGrantResult {
  if (!opts.subject) {
    return { ok: true, grant: grantFromLoadedAgents(agentName, loaded) };
  }

  const findDeclared = (name: string) => loaded.specs.find((s) => s.name === name && s.enabled);

  if (agentName === DEFAULT_AGENT_SENTINEL) {
    const declaredDefault = opts.projectDefaultAgent ?? loaded.defaultAgent;
    if (!declaredDefault) {
      return {
        ok: false,
        code: 'AGENT_NOT_DECLARED',
        error:
          'This project requires declared agents but has no default_agent configured — ' +
          'set one in the project settings or kortix.toml before starting a session.',
      };
    }
    const spec = findDeclared(declaredDefault);
    if (!spec) {
      return {
        ok: false,
        code: 'AGENT_NOT_DECLARED',
        error: `This project's default agent "${declaredDefault}" is not declared (or is disabled) in [[agents]] — the "default" sentinel cannot resolve.`,
      };
    }
    return {
      ok: true,
      grant: { agent: declaredDefault, kortixCli: spec.kortixCli, connectors: spec.connectors, env: spec.env },
    };
  }

  const spec = findDeclared(agentName);
  if (!spec) {
    return {
      ok: false,
      code: 'AGENT_NOT_DECLARED',
      error: `Agent "${agentName}" is not declared in this project's [[agents]] manifest — this project requires every session/trigger to name a declared agent.`,
    };
  }
  return { ok: true, grant: { agent: agentName, kortixCli: spec.kortixCli, connectors: spec.connectors, env: spec.env } };
}

/**
 * Convert an AgentSpec back to the TOML-shaped object for the CRUD round-trip.
 * Inverse of `parseAgentEntry`. Omits empty/default fields so the emitted TOML
 * stays minimal.
 */
export function agentSpecToTomlEntry(spec: AgentSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: spec.name };
  if (!spec.enabled) entry.enabled = false;
  if (spec.file) entry.file = spec.file;
  if (spec.model) entry.model = spec.model;
  if (spec.connectors === 'all') entry.connectors = 'all';
  else if (spec.connectors.length > 0) entry.connectors = spec.connectors;
  if (spec.kortixCli === 'all') entry.kortix_cli = 'all';
  else if (spec.kortixCli.length > 0) entry.kortix_cli = spec.kortixCli;
  // 'all' is the env default, so only emit when narrowed (a list or explicit none).
  if (spec.env !== 'all') entry.env = spec.env;
  return entry;
}

/**
 * Apply a secrets/connectors scope edit to the RAW `[[agents]]` array (the
 * dashboard "Access scope" editor's write step), returning a new array. Pure —
 * the route wraps it with load/commit. Preserves every other field on the entry
 * (name, model, file, kortix_cli, enabled) and omits a key when it equals the
 * parser default so the emitted TOML matches hand-authored files:
 *   - env:        'all' is the default → omit; a list/`[]` narrows it.
 *   - connectors: none is the default → omit `[]`; 'all'/a list is explicit.
 * Returns an error (not a throw) when the agent isn't declared.
 */
export function applyAgentScope(
  agents: Record<string, unknown>[],
  agentName: string,
  scope: { env?: GrantSet; connectors?: GrantSet },
  filename: string = MANIFEST_FILENAME,
): { ok: true; agents: Record<string, unknown>[] } | { ok: false; error: string } {
  const idx = agents.findIndex((a) => a && (a as { name?: unknown }).name === agentName);
  if (idx < 0) return { ok: false, error: `No agent "${agentName}" declared in ${filename}` };
  const entry = { ...agents[idx] };
  if (scope.env !== undefined) {
    if (scope.env === 'all') delete entry.env;
    else entry.env = scope.env;
  }
  if (scope.connectors !== undefined) {
    if (scope.connectors === 'all') entry.connectors = 'all';
    else if (scope.connectors.length === 0) delete entry.connectors;
    else entry.connectors = scope.connectors;
  }
  const next = [...agents];
  next[idx] = entry;
  return { ok: true, agents: next };
}

/**
 * Stable hash over what should trigger a re-reconcile of the agent's grant.
 * `name` is excluded — renaming is handled by the name being the key.
 */
export function manifestHashForAgent(spec: AgentSpec): string {
  const canonical = JSON.stringify({
    enabled: spec.enabled,
    connectors: spec.connectors,
    kortixCli: spec.kortixCli,
    env: spec.env,
    file: spec.file,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParseOk { ok: true; spec: AgentSpec }
interface ParseErr { ok: false; error: AgentParseError }

function parseAgentEntry(entry: unknown, index: number, filename: string = MANIFEST_FILENAME): ParseOk | ParseErr {
  const err = (name: string, message: string): ParseErr => makeAgentError(name, message, filename);

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `[[agents]] entry #${index + 1} is not a table`);
  }
  const row = entry as Record<string, unknown>;

  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) return err(`(index-${index})`, `[[agents]] entry #${index + 1} is missing a name`);
  if (!NAME_RE.test(name)) {
    return err(name, `Invalid agent name "${name}" — lowercase letters, digits, dashes, underscores only`);
  }

  const enabled = coerceBool(row.enabled, true);
  const file = typeof row.file === 'string' && row.file.trim() ? row.file.trim() : null;
  const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null;

  const connectorsParsed = parseGrantSet(name, 'connectors', row.connectors, null, filename);
  if (!connectorsParsed.ok) return connectorsParsed;

  const kortixParsed = parseGrantSet(name, 'kortix_cli', row.kortix_cli, validateKortixAction, filename);
  if (!kortixParsed.ok) return kortixParsed;

  // `env` is a NEW dimension — default to 'all' when omitted so existing
  // [[agents]] keep receiving the secrets they already got; an explicit list
  // (or "none"/[]) opts into per-agent secret scoping.
  const envParsed =
    row.env === undefined || row.env === null
      ? ({ ok: true as const, value: 'all' as const })
      : parseGrantSet(name, 'env', row.env, null, filename);
  if (!envParsed.ok) return envParsed;

  return {
    ok: true,
    spec: {
      name,
      path: `${filename}#agents.${name}`,
      enabled,
      connectors: connectorsParsed.value,
      kortixCli: kortixParsed.value,
      env: envParsed.value,
      file,
      model,
    },
  };
}

/**
 * Parse one v2 `agents.<name>` block (a map entry, not an array table) into
 * an `AgentSpec`. Reuses `resolveGrantSet` from `@kortix/manifest-schema` so
 * v2's deny-by-default default (an omitted grant → `'none'`) is shared, not
 * re-derived — the opposite default from v1's `parseGrantSet` above, which
 * defaults `env` to `'all'` (adopt-to-govern back-compat for an existing
 * dimension). `kortix_cli` actions are still validated against the grantable
 * project-action set here (not just at `kortix validate` time), so a manifest
 * that reached this reader without going through the CR-merge gate (a raw git
 * push / out-of-band edit) can't smuggle an ungrantable action into a grant.
 */
function parseAgentEntryV2(name: string, block: unknown, filename: string): ParseOk | ParseErr {
  const err = (n: string, message: string): ParseErr => makeAgentError(n, message, filename);

  if (!NAME_RE.test(name)) {
    return err(name, `Invalid agent name "${name}" — lowercase letters, digits, dashes, underscores only`);
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return err(name, `agents.${name} must be a table/object`);
  }
  const row = block as Record<string, unknown>;

  // v2's `enabled` is a top-level Kortix-governance boolean (validated
  // upstream by manifest-schema); only a literal `false` disables. Behavior
  // (`file`/`model`) is NOT read from the manifest anymore (2026-07-05
  // redirect, spec §2.2: "one home per concern") — it lives entirely in the
  // agent's own `.kortix/opencode/agents/<name>.md` frontmatter, which this
  // GOVERNANCE-only parser has no reason to read (no I/O here). `file` stays
  // `null`, which downstream callers already treat as "use the conventional
  // `.md` by name" (see `AgentSpec.file`'s doc comment); `model` stays `null`,
  // which the session model-resolution chain already treats as "fall through
  // to account/platform" — the compiler (compile-agent-config.ts) is what
  // actually resolves a per-agent model now, straight from that same `.md`.
  const enabled = row.enabled !== false;
  const file: string | null = null;
  const model: string | null = null;

  const connectorsResolved = resolveGrantSet(row.connectors, 'none');

  const kortixResolved = resolveGrantSet(row.kortix_cli, 'none');
  if (Array.isArray(kortixResolved)) {
    for (const action of kortixResolved) {
      const problem = validateKortixAction(action);
      if (problem) return err(name, problem);
    }
  }

  // v2 renamed the grant-set key `env` → `secrets` (spec §2.2/§2.4); same
  // shape as connectors/kortix_cli, same deny-by-default resolution — mapped
  // onto AgentSpec's `env` field, which the rest of the pipeline (secret
  // scoping in sessions.ts, `agentMayUseEnv`) already consumes.
  const secretsResolved = resolveGrantSet(row.secrets, 'none');

  return {
    ok: true,
    spec: {
      name,
      path: `${filename}#agents.${name}`,
      enabled,
      connectors: toGrantSet(connectorsResolved),
      kortixCli: toGrantSet(kortixResolved),
      env: toGrantSet(secretsResolved),
      file,
      model,
    },
  };
}

/** `resolveGrantSet` returns `'none'` as its own sentinel; `AgentSpec`'s grant
 *  fields use `[]` for "deny" (matching v1 + `AgentGrant`'s wire shape) — this
 *  is the one-line adapter between the two. */
function toGrantSet(value: GrantSetV2): GrantSet {
  return value === 'none' ? [] : value;
}

/**
 * Parse a `connectors` / `kortix_cli` value, which may be:
 *   - omitted / null          → [] (default-deny)
 *   - the string "all"        → 'all'
 *   - the string "none"       → []
 *   - an array of strings     → validated list (each via `validate`, if given)
 */
function parseGrantSet(
  name: string,
  key: string,
  raw: unknown,
  validate: ((entry: string) => string | null) | null,
  filename: string = MANIFEST_FILENAME,
): { ok: true; value: GrantSet } | ParseErr {
  const err = (n: string, message: string): ParseErr => makeAgentError(n, message, filename);
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'all') return { ok: true, value: 'all' };
    if (v === 'none' || v === '') return { ok: true, value: [] };
    return err(name, `\`${key}\` string must be "all" or "none" — use an array for a specific list`);
  }
  if (!Array.isArray(raw)) {
    return err(name, `\`${key}\` must be an array of strings, "all", or "none"`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'string' || !item.trim()) {
      return err(name, `\`${key}\` entry #${i + 1} must be a non-empty string`);
    }
    const value = item.trim();
    if (value === '*') return { ok: true, value: 'all' };
    if (validate) {
      const problem = validate(value);
      if (problem) return err(name, problem);
    }
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return { ok: true, value: out };
}

/** Returns an error message if the action is not grantable to an agent, else null. */
function validateKortixAction(action: string): string | null {
  if (GRANTABLE_KORTIX_CLI.has(action)) return null;
  if (VALID_ACTIONS.has(action)) {
    return `\`kortix_cli\` action "${action}" is account-scoped and can never be granted to an agent — only project-scoped actions are allowed`;
  }
  return `\`kortix_cli\` has unknown action "${action}" — see the grantable list (project.*)`;
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

function makeAgentError(name: string, message: string, filename: string = MANIFEST_FILENAME): ParseErr {
  return {
    ok: false,
    error: { name, path: `${filename}#agents.${name}`, error: message },
  };
}
