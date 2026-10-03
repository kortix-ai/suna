import type { ParsedManifest } from '../triggers';
import { PROJECT_ACTIONS, VALID_ACTIONS } from '../../iam/actions';
import type { GitBackedProject, MirrorRefresh } from '../git';
import {
  DEPRECATED_KORTIX_PERMISSION_ALIASES,
  resolveGrantSet,
  safeAgentFile,
  SLUG_RE,
  WORKSPACE_MODES_V2,
  type GrantSetV2,
} from '@kortix/manifest-schema';
import { normalizeRequiredConnectorAliases } from '../lib/agent-config-v2';
import {
  MANIFEST_FILENAME,
  type AgentParseError,
  type AgentSpec,
  type GrantSet,
  type LoadedAgents,
} from './types';

/**
 * The actions an agent's `kortix_permissions` may grant — the project-scoped surface,
 * including the manager-tier project leaves (`project.delete`,
 * `project.members.manage`, `project.gateway.keys.manage`) — these are still
 * reachable via a project's `manager` role, so an agent can be granted them
 * too. CR actions live in PROJECT_ACTIONS. The channel.* resource actions
 * (channel.send, …) were removed from the catalog (IAM enforcement audit):
 * they were never wired to any route, so granting them did nothing — see
 * iam/actions.ts.
 *
 * Account-scoped admin actions (member.*, billing.*, token.*, project.create,
 * …) are excluded — but simply omitting them from this list is not what
 * stops an agent from calling them. Every agent-session token is
 * project-scoped (`account_tokens.project_id`); the IAM v2 engine
 * (`iam/engine-v2.ts` `computeTokenScope`) refuses ANY account-scope action
 * for a project-bound token BEFORE this grant is even loaded. This set is a
 * curation/UX surface (the CLI/editor's offered catalog, and what
 * `validateKortixAction` below flags as a bad `kortix_permissions` entry), not the
 * enforcement boundary itself.
 */
export const GRANTABLE_KORTIX_PERMISSIONS: ReadonlySet<string> = new Set(Object.values(PROJECT_ACTIONS));

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
        error:
          manifest.format === 'yaml'
            ? '`agents` must be a list — write it as a YAML `agents:` list (or a name→block map in v2), not a scalar.'
            : '`agents` must be an array of tables — use [[agents]], not [agents]',
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
 *   - `connectors` / `kortix_permissions` / `secrets` (v2's rename of v1's `env`) are
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
          `\`agents\` must be a map of agent name → agent block in kortix_version ${manifest.schemaVersion} (the v1 \`[[agents]]\` array becomes a map)`,
      }],
      defaultAgent: null,
    };
  }

  const specs: AgentSpec[] = [];
  const errors: AgentParseError[] = [];

  for (const [name, block] of Object.entries(raw as Record<string, unknown>)) {
    // With `imports:`, attribute the agent to the file that declares it.
    const result = parseAgentEntryV2(name, block, manifest.imports?.origins.agents[name] ?? filename, manifest.schemaVersion);
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
 *
 * A project with NO manifest committed yet (a blank managed-git project
 * provisioned without `seed_starter:true`) is treated as if
 * `synthesizeBlankManifest` (./triggers.ts) already existed on disk — the
 * SAME synthesized shape `loadManifestForEdit` (lib/triggers.ts) uses on the
 * agent-config WRITE path. Without this, the two paths disagreed: a blank
 * project's agent-config PUT (write path) would succeed against the
 * synthesized manifest, but session-create (this read path) still saw
 * `readManifest`'s literal `null` → zero declared agents → every
 * declared-agent check (`resolveGovernedAgentGrant`) 400'd AGENT_NOT_DECLARED
 * even though the project "should" already resolve to the synthesized
 * `kortix` default agent with zero writes. Synthesizing here too closes that
 * gap — a blank project's very first session-create with no agent forced now
 * resolves the same declared default the write path already promises.
 */
export async function loadProjectAgents(
  project: GitBackedProject,
  opts?: { forceRefresh?: MirrorRefresh; rethrowReadErrors?: boolean },
): Promise<LoadedAgents> {
  const { readManifest, synthesizeBlankManifest } = await import('../triggers');
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(project, opts);
  } catch (err) {
    // FAIL CLOSED for callers that asked to. Both failure modes reaching here —
    // an unreadable manifest (rethrown by readManifest) and an unparseable one
    // (parseManifestString throwing) — mean the same thing: we cannot determine
    // this agent's grant. Neither may be laundered into a permissive answer.
    //
    // Swallowing them is a fail-OPEN for the two most common session shapes: an
    // unreadable manifest becomes a synthesized `secrets: 'all'` manifest below,
    // and an unparseable one produces the error-carrying result below, which
    // `grantFromLoadedAgents` resolves to null — i.e. UNRESTRICTED — for the
    // `default` sentinel. See projects/lib/secret-grant.ts.
    if (opts?.rethrowReadErrors) throw err;
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
      manifest: null,
    };
  }
  if (!manifest) manifest = synthesizeBlankManifest({ manifestPath: project.manifestPath });
  return {
    ...extractAgents(manifest),
    manifest: { revision: manifest.revision ?? null, commit: manifest.commit ?? null },
  };
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
  if (!SLUG_RE.test(name)) {
    return err(name, `Invalid agent name "${name}" — lowercase letters, digits, dashes, underscores only`);
  }

  const enabled = coerceBool(row.enabled, true);
  const file = typeof row.file === 'string' && row.file.trim() ? row.file.trim() : null;
  const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null;

  const connectorsParsed = parseGrantSet(name, 'connectors', row.connectors, null, filename);
  if (!connectorsParsed.ok) return connectorsParsed;

  const permissionsRaw = resolvePermissionsKey(name, row, filename);
  if (!permissionsRaw.ok) return permissionsRaw;
  const kortixParsed = parseGrantSet(name, permissionsRaw.key, permissionsRaw.value, validateKortixAction, filename);
  if (!kortixParsed.ok) return kortixParsed;

  // `env` is a NEW dimension — default to 'all' when omitted so existing
  // [[agents]] keep receiving the secrets they already got; an explicit list
  // (or "none"/[]) opts into per-agent secret scoping.
  const envParsed =
    row.env === undefined || row.env === null
      ? ({ ok: true as const, value: 'all' as const })
      : parseGrantSet(name, 'env', row.env, null, filename);
  if (!envParsed.ok) return envParsed;

  // `apps` (spec 2026-09-22 §2.5): omitted = none, like connectors.
  const appsParsed = parseGrantSet(name, 'apps', row.apps, null, filename);
  if (!appsParsed.ok) return appsParsed;

  return {
    ok: true,
    spec: {
      name,
      path: `${filename}#agents.${name}`,
      enabled,
      connectors: connectorsParsed.value,
      permissions: kortixParsed.value,
      env: envParsed.value,
      apps: appsParsed.value,
      file,
      model,
      sandbox: null,
      repositoryAccess: true,
    },
  };
}

/**
 * Parse one v2 `agents.<name>` block (a map entry, not an array table) into
 * an `AgentSpec`. Reuses `resolveGrantSet` from `@kortix/manifest-schema` so
 * v2's deny-by-default default (an omitted grant → `'none'`) is shared, not
 * re-derived — the opposite default from v1's `parseGrantSet` above, which
 * defaults `env` to `'all'` (adopt-to-govern back-compat for an existing
 * dimension). `kortix_permissions` actions are still validated against the grantable
 * project-action set here (not just at `kortix validate` time), so a manifest
 * that reached this reader without going through the CR-merge gate (a raw git
 * push / out-of-band edit) can't smuggle an ungrantable action into a grant.
 */
function parseAgentEntryV2(name: string, block: unknown, filename: string, version: number): ParseOk | ParseErr {
  const err = (n: string, message: string): ParseErr => makeAgentError(n, message, filename);

  if (!SLUG_RE.test(name)) {
    return err(name, `Invalid agent name "${name}" — lowercase letters, digits, dashes, underscores only`);
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return err(name, `agents.${name} must be a table/object`);
  }
  const row = block as Record<string, unknown>;
  const normalizedRequired = normalizeRequiredConnectorAliases(row);
  if (!normalizedRequired.ok) return err(name, `agents.${name}.${normalizedRequired.error}`);
  const normalizedRow = normalizedRequired.block;

  // v2's `enabled` is a top-level Kortix-governance boolean (validated
  // upstream by manifest-schema); only a literal `false` disables. Behavior
  // (`model` and the rest) is NOT read from the manifest (2026-07-05
  // redirect, spec §2.2: "one home per concern") — it lives entirely in the
  // agent's own `.md` frontmatter, which this GOVERNANCE-only parser has no
  // reason to read (no I/O here). `file` is the explicit `agents.<name>.file`
  // or `null`, which downstream callers treat as "use the conventional `.md`
  // by name" (`agentFileCandidates` in @kortix/manifest-schema); `model` stays
  // `null`, which the session model-resolution chain already treats as "fall
  // through to account/platform" — the compiler (compile-agent-config.ts) is
  // what actually resolves a per-agent model now, straight from that `.md`.
  const enabled = normalizedRow.enabled !== false;
  if (normalizedRow.file !== undefined && !safeAgentFile(normalizedRow.file)) {
    return err(name, `agents.${name}.file must be a repo-relative path to a .md file`);
  }
  const file: string | null = safeAgentFile(normalizedRow.file);
  const model: string | null = version === 3 && typeof normalizedRow.model === 'string' ? normalizedRow.model : null;
  const sandbox =
    typeof normalizedRow.sandbox === 'string' && normalizedRow.sandbox.trim()
      ? normalizedRow.sandbox.trim()
      : null;
  const workspaceRaw = normalizedRow.workspace;
  if (
    workspaceRaw !== undefined &&
    (typeof workspaceRaw !== 'string' ||
      !(WORKSPACE_MODES_V2 as readonly string[]).includes(workspaceRaw))
  ) {
    return err(name, `agents.${name}.workspace must be one of: ${WORKSPACE_MODES_V2.join(', ')}`);
  }
  const repositoryAccessRaw = normalizedRow.repository_access;
  if (repositoryAccessRaw !== undefined && typeof repositoryAccessRaw !== 'boolean') {
    return err(name, `agents.${name}.repository_access must be a boolean`);
  }
  if (repositoryAccessRaw !== undefined && workspaceRaw !== undefined &&
      repositoryAccessRaw !== (workspaceRaw === 'branch')) {
    return err(name, `agents.${name}.repository_access conflicts with workspace`);
  }
  const repositoryAccess = repositoryAccessRaw ?? (workspaceRaw === undefined || workspaceRaw === 'branch');
  const legacyReadWorkspace = workspaceRaw === 'read' && repositoryAccessRaw === undefined;

  const connectorsResolved = resolveGrantSet(normalizedRow.connectors, 'none');

  const connectorsRequired = (normalizedRow.connectors_required as string[] | undefined) ?? [];
  if (connectorsRequired.length > 0) {
    if (connectorsResolved !== 'all') {
      const granted = new Set<string>(connectorsResolved === 'none' ? [] : connectorsResolved);
      const notGranted = connectorsRequired.filter((slug) => !granted.has(slug));
      if (notGranted.length > 0) {
        return err(
          name,
          `agents.${name}.connectors_required must be a subset of connectors — not granted: ${notGranted.join(', ')}`,
        );
      }
    }
  }

  const permissionsRaw = resolvePermissionsKey(name, normalizedRow, filename);
  if (!permissionsRaw.ok) return permissionsRaw;
  const kortixResolved = resolveGrantSet(permissionsRaw.value, 'none');
  if (Array.isArray(kortixResolved)) {
    for (const action of kortixResolved) {
      const problem = validateKortixAction(action);
      if (problem) return err(name, problem);
    }
  }

  // v2 renamed the grant-set key `env` → `secrets` (spec §2.2/§2.4); same
  // shape as connectors/kortix_permissions, same deny-by-default resolution — mapped
  // onto AgentSpec's `env` field, which the rest of the pipeline (secret
  // scoping in sessions.ts, `agentMayUseEnv`) already consumes.
  const secretsResolved = resolveGrantSet(normalizedRow.secrets, 'none');
  // `apps` (spec 2026-09-22 §2.5): same shape, deny-by-default.
  const appsResolved = resolveGrantSet(normalizedRow.apps, 'none');

  return {
    ok: true,
    spec: {
      name,
      path: `${filename}#agents.${name}`,
      enabled,
      connectors: toGrantSet(connectorsResolved),
      connectorsRequired,
      permissions: toGrantSet(kortixResolved),
      env: toGrantSet(secretsResolved),
      apps: toGrantSet(appsResolved),
      file,
      model,
      sandbox,
      repositoryAccess,
      legacyReadWorkspace,
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
 * Parse a `connectors` / `kortix_permissions` value, which may be:
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

/**
 * Pick the raw project-permission grant from an agent entry. `kortix_permissions`
 * is canonical; `kortix_cli` is the deprecated alias (the pre-rename key). Both
 * present with different values is an error — the validator rejects it too
 * (`validateKortixPermissionFields`), and picking one silently would let a
 * manifest mean two things.
 */
function resolvePermissionsKey(
  name: string,
  row: Record<string, unknown>,
  filename: string,
): { ok: true; key: string; value: unknown } | ParseErr {
  const canonical = row.kortix_permissions;
  const legacy = row.kortix_cli;
  const has = (v: unknown) => v !== undefined && v !== null;
  if (has(canonical) && has(legacy) && grantValueKey(canonical) !== grantValueKey(legacy)) {
    return makeAgentError(
      name,
      '`kortix_cli` is the deprecated alias of `kortix_permissions` and must match it when both are present — remove `kortix_cli`',
      filename,
    );
  }
  if (has(canonical)) return { ok: true, key: 'kortix_permissions', value: canonical };
  if (has(legacy)) return { ok: true, key: 'kortix_cli', value: legacy };
  return { ok: true, key: 'kortix_permissions', value: undefined };
}

/** Order-insensitive comparison key for a raw grant-set value. */
function grantValueKey(v: unknown): string {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '' ? 'none' : t;
  }
  if (Array.isArray(v)) {
    return JSON.stringify([...new Set(v.map((x) => (typeof x === 'string' ? x.trim() : JSON.stringify(x))))].sort());
  }
  return JSON.stringify(v);
}

/** Returns an error message if the action is not grantable to an agent, else null. */
function validateKortixAction(action: string): string | null {
  if (GRANTABLE_KORTIX_PERMISSIONS.has(action)) return null;
  // A RENAMED action still resolves — `canonicalizeGrantActions` rewrites it to
  // the live leaf. Accept it here: rejecting it would push the spec into
  // `loaded.errors`, and an agent whose manifest failed to parse is given an
  // EMPTY grant (see grantFromLoadedAgents), which strips every capability it
  // holds over one outdated string.
  if (action in DEPRECATED_KORTIX_PERMISSION_ALIASES) return null;
  if (VALID_ACTIONS.has(action)) {
    return `\`kortix_permissions\` action "${action}" is account-scoped and can never be granted to an agent — only project-scoped actions are allowed`;
  }
  return `\`kortix_permissions\` has unknown action "${action}" — see the grantable list (project.*)`;
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
