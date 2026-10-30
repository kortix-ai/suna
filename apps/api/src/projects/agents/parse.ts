import type { ParsedManifest } from '../triggers';
import { logger } from '../../lib/logger';
import { PROJECT_ACTIONS, VALID_ACTIONS } from '../../iam/actions';
import type { GitBackedProject, MirrorRefresh } from '../git';
import {
  DEPRECATED_KORTIX_PERMISSION_ALIASES,
  resolveGrantSet,
  SLUG_RE,
  resolveProjectRepository,
  type GrantSetV2,
} from '@kortix/manifest-schema';
import { readAgentBlockV2 } from '../lib/agent-config-v2';
import { declaredBuiltinAgents } from '../lib/my-kortix-agent';
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
 * Pull the manifest's agent declarations (the `agents:` name → block map) out
 * of a parsed manifest. Never throws: a bad entry lands in `errors`.
 */
export function extractAgents(manifest: ParsedManifest): LoadedAgents {
  const filename = manifest.path || MANIFEST_FILENAME;
  const raw = manifest.raw.agents;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [], defaultAgent: null };
  }
  if (Array.isArray(raw) || typeof raw !== 'object') {
    return {
      specs: [],
      errors: [{ name: '(top-level)', path: filename, error: '`agents` must be a map of agent name → agent block' }],
      defaultAgent: null,
    };
  }

  const specs: AgentSpec[] = [];
  const errors: AgentParseError[] = [];
  for (const [name, block] of Object.entries(raw as Record<string, unknown>)) {
    // With `imports:`, attribute the agent to the file that declares it.
    const result = parseAgentEntry(name, block, manifest.imports?.origins.agents[name] ?? filename);
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
 * Does the manifest declare this agent at all — the roster every agent-name
 * gate shares (KRTX-2071/KRTX-2535): the `agents:` map, where
 * `readAgentBlockV2`'s ok-but-null block means the name is absent.
 */
function manifestDeclaresAgent(manifest: ParsedManifest, agentName: string): boolean {
  const read = readAgentBlockV2(manifest, agentName);
  return read.ok && read.block !== null;
}

/**
 * The not-declared verdict + message the agent-name gates share: the config
 * GET (404) and the agent model-pin PUT (409). Names the declared agents so a
 * caller can self-correct. `null` = the agent is declared; the caller
 * proceeds.
 */
export function agentNotDeclaredError(
  manifest: ParsedManifest,
  agentName: string,
): { error: string; code: 'agent_not_found' } | null {
  if (manifestDeclaresAgent(manifest, agentName)) return null;
  const declared = extractAgents(manifest).specs.map((spec) => spec.name);
  const listed = declared.length > 0 ? declared.join(', ') : 'none';
  return {
    error: `No agent "${agentName}" declared in ${manifest.path || MANIFEST_FILENAME}. Declared agents: ${listed}.`,
    code: 'agent_not_found',
  };
}

/**
 * Read + parse a project's manifest, then extract its agents. Never throws.
 * The roster is the one a running project applies (`runtimeManifest`): an
 * agent with a validation error is `enabled: false`, and `issues` names why.
 *
 * A project with NO manifest committed yet (a blank managed-git project
 * provisioned without `seed_starter:true`) is treated as if
 * `synthesizeBlankManifest` (./triggers.ts) already existed on disk — the
 * SAME synthesized shape `loadManifestForEdit` (lib/triggers.ts) uses on the
 * agent-config WRITE path, so a blank project's first session-create resolves
 * the same declared default the write path already promises.
 */
export async function loadProjectAgents(
  project: GitBackedProject,
  opts?: { forceRefresh?: MirrorRefresh; rethrowReadErrors?: boolean },
): Promise<LoadedAgents> {
  const { readManifest, runtimeManifest, synthesizeBlankManifest } = await import('../triggers');
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
  const applied = runtimeManifest(manifest ?? synthesizeBlankManifest({ manifestPath: project.manifestPath }));
  return {
    ...extractAgents(applied),
    issues: applied.issues,
    builtinAgents: declaredBuiltinAgents(applied.raw),
    manifest: { revision: applied.revision ?? null, commit: applied.commit ?? null },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParseOk { ok: true; spec: AgentSpec }
interface ParseErr { ok: false; error: AgentParseError }

/**
 * Parse one `agents.<name>` block into an `AgentSpec`. Grants are
 * deny-by-default (`resolveGrantSet(…, 'none')`). `kortix_permissions` actions
 * are still checked against the grantable project-action set here (not just
 * at `kortix validate` time), so a manifest that reached this reader without
 * the CR-merge gate (a raw git push) can't smuggle an ungrantable action into
 * a grant.
 */
function parseAgentEntry(name: string, block: unknown, filename: string): ParseOk | ParseErr {
  const err = (message: string): ParseErr => makeAgentError(name, message, filename);

  if (!SLUG_RE.test(name)) {
    return err(`Invalid agent name "${name}" — lowercase letters, digits, dashes, underscores only`);
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return err(`agents.${name} must be a table/object`);
  }
  const row = block as Record<string, unknown>;
  // Only a literal `false` disables (the validator rejects any other value).
  const enabled = row.enabled !== false;
  const model = typeof row.model === 'string' ? row.model : null;
  const sandbox = typeof row.sandbox === 'string' && row.sandbox.trim() ? row.sandbox.trim() : null;
  const repository = resolveProjectRepository(row);
  if (!repository.ok) return err(`agents.${name}.${repository.path} ${repository.message}`);

  const connectorsResolved = resolveGrantSet(row.connectors, 'none');
  const connectorsRequired = Array.isArray(row.connectors_required)
    ? row.connectors_required.filter((slug): slug is string => typeof slug === 'string')
    : [];
  if (connectorsRequired.length > 0 && connectorsResolved !== 'all') {
    const granted = new Set<string>(connectorsResolved === 'none' ? [] : connectorsResolved);
    const notGranted = connectorsRequired.filter((slug) => !granted.has(slug));
    if (notGranted.length > 0) {
      return err(`agents.${name}.connectors_required must be a subset of connectors — not granted: ${notGranted.join(', ')}`);
    }
  }

  // An action that is not grantable drops out of the list on its own. Failing
  // the entry instead gave the agent an EMPTY grant on every dimension (a
  // prod `kortix` agent lost connectors and secrets over one bad string). The
  // validator still rejects it, so a CR or `kortix validate` names it.
  const kortixRaw = resolveGrantSet(row.kortix_permissions, 'none');
  const kortixResolved = Array.isArray(kortixRaw)
    ? kortixRaw.filter((action) => {
        const problem = validateKortixAction(action);
        if (problem) logger.warn('[agents] ignoring an ungrantable kortix_permissions entry', { agent: name, filename, problem });
        return !problem;
      })
    : kortixRaw;

  const policySets = readAgentPolicySets(row.policy_sets);
  return {
    ok: true,
    spec: {
      name,
      path: `${filename}#agents.${name}`,
      enabled,
      connectors: toGrantSet(connectorsResolved),
      connectorsRequired,
      ...(policySets ? { policySets } : {}),
      permissions: toGrantSet(kortixResolved),
      // `secrets` maps onto AgentSpec's `env`, which secret scoping
      // (sessions.ts, `agentMayUseEnv`) consumes.
      env: toGrantSet(resolveGrantSet(row.secrets, 'none')),
      apps: toGrantSet(resolveGrantSet(row.apps, 'none')),
      model,
      sandbox,
      repositoryAccess: repository.value,
      legacyReadWorkspace: repository.legacyRead,
    },
  };
}

/** The `*` key of a policy-set map: every connector, used when the whole
 *  `policy_sets` value is malformed. Not a valid slug, so it never collides. */
export const ALL_CONNECTORS_POLICY_SET_KEY = '*';

/**
 * `agents.<name>.policy_sets` → connector slug → set name, on a null
 * prototype (a slug such as `constructor` must not read `Object.prototype`).
 *
 * Never invalidates the agent (an invalid agent loses every connector,
 * channel included) and never drops an entry (no entry = base rules = looser).
 * A malformed value becomes the set name `''`, which no connector defines, so
 * the gateway blocks that connector for the agent. A malformed map blocks
 * every connector (`*`). `kortix validate` and the CR gate name the problem.
 */
export function readAgentPolicySets(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const out: Record<string, string> = Object.create(null);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('[agents] malformed policy_sets: every connector is blocked for this agent');
    out[ALL_CONNECTORS_POLICY_SET_KEY] = '';
    return out;
  }
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    out[slug.trim()] = typeof value === 'string' ? value.trim() : '';
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `resolveGrantSet` returns `'none'` as its own sentinel; `AgentSpec`'s grant
 *  fields use `[]` for "deny" (matching `AgentGrant`'s wire shape). */
function toGrantSet(value: GrantSetV2): GrantSet {
  return value === 'none' ? [] : value;
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

function makeAgentError(name: string, message: string, filename: string = MANIFEST_FILENAME): ParseErr {
  return {
    ok: false,
    error: { name, path: `${filename}#agents.${name}`, error: message },
  };
}
