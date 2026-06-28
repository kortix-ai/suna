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
import { PROJECT_ACTIONS, CHANNEL_ACTIONS, VALID_ACTIONS } from '../iam/actions';
import type { GitBackedProject } from './git';
import type { AgentGrant } from '@kortix/db';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MANIFEST_FILENAME = 'kortix.toml';

/**
 * The actions an agent's `kortix_cli` may grant — the project-scoped surface.
 * Account-scoped admin actions (member.*, billing.*, token.*, project.create, …)
 * are deliberately excluded: they're the hard ceiling and can never be granted
 * to an agent. CR actions live in PROJECT_ACTIONS.
 */
export const GRANTABLE_KORTIX_CLI: ReadonlySet<string> = new Set([
  ...Object.values(PROJECT_ACTIONS),
  ...Object.values(CHANNEL_ACTIONS),
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
}

/**
 * Pull `[[agents]]` out of a parsed manifest. Never throws.
 */
export function extractAgents(manifest: ParsedManifest): LoadedAgents {
  const raw = manifest.raw.agents;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [{
        name: '(top-level)',
        path: MANIFEST_FILENAME,
        error: '`agents` must be an array of tables — use [[agents]], not [agents]',
      }],
    };
  }

  const specs: AgentSpec[] = [];
  const errors: AgentParseError[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const result = parseAgentEntry(entry, index);
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
  return { specs, errors };
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
    return {
      specs: [],
      errors: [{
        name: '(manifest)',
        path: MANIFEST_FILENAME,
        error: (err as Error).message || 'Failed to read manifest',
      }],
    };
  }
  if (!manifest) return { specs: [], errors: [] };
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
    return { agent: agentName, kortixCli: spec.kortixCli, connectors: spec.connectors };
  }

  // Governance adopted but this agent is unlisted → default-deny.
  return { agent: agentName, kortixCli: [], connectors: [] };
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
  return entry;
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
    file: spec.file,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParseOk { ok: true; spec: AgentSpec }
interface ParseErr { ok: false; error: AgentParseError }

function parseAgentEntry(entry: unknown, index: number): ParseOk | ParseErr {
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

  const connectorsParsed = parseGrantSet(name, 'connectors', row.connectors, null);
  if (!connectorsParsed.ok) return connectorsParsed;

  const kortixParsed = parseGrantSet(name, 'kortix_cli', row.kortix_cli, validateKortixAction);
  if (!kortixParsed.ok) return kortixParsed;

  return {
    ok: true,
    spec: {
      name,
      path: `${MANIFEST_FILENAME}#agents.${name}`,
      enabled,
      connectors: connectorsParsed.value,
      kortixCli: kortixParsed.value,
      file,
      model,
    },
  };
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
): { ok: true; value: GrantSet } | ParseErr {
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
  return `\`kortix_cli\` has unknown action "${action}" — see the grantable list (project.* / channel.*)`;
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

function err(name: string, message: string): ParseErr {
  return {
    ok: false,
    error: { name, path: `${MANIFEST_FILENAME}#agents.${name}`, error: message },
  };
}
