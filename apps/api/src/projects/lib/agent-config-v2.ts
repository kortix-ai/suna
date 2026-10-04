/**
 * Read/write helpers for the v2 `agents.<name>` GOVERNANCE block (redirected
 * 2026-07-05 — "one home per concern"). `AgentBlockV2` here is governance
 * ONLY: connectors/secrets/skills/kortix_permissions/repository_access/enabled, plus
 * `file` (the path of the agent's `.md`). Agent BEHAVIOR (mode/model/
 * temperature/top_p/steps/variant/color/hidden/permission/prompt) lives
 * entirely in that `.md` frontmatter + body — see `./agent-markdown.ts`
 * (parse/serialize) and `./compile-agent-config.ts` (`agentMarkdownPath`,
 * `readAgentMarkdownFile`). The dashboard's agent
 * editor route (`../routes/agent-config.ts`) is what merges this governance
 * half with the `.md` behavior half into one wire response/request — this
 * module only ever touches kortix.yaml.
 *
 * Distinct from `../agents.ts` (`AgentSpec` / `extractAgents`): that module
 * resolves the platform GRANT the session token carries (a narrower view —
 * connectors/secrets/kortix_permissions reduced to the wire `AgentGrant` shape).
 * This module instead reads/writes the agent's declared governance block
 * verbatim so the editor can present (and persist) the complete governance
 * field space, not just the grant subset. Pure — no I/O; callers own
 * load/commit (mirrors `applyAgentScope` in `../agents.ts`).
 */
import {
  type AgentBlockV2,
  resolveGrantSet,
  SLUG_RE,
  validateManifest,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import type { ParsedManifest } from '../triggers';
import { isDeepStrictEqual } from 'node:util';

/** Slug rule for an agent name — same as every other manifest slug. Reuses
 *  `@kortix/manifest-schema`'s exported `SLUG_RE` directly (it used to be
 *  re-derived here as a local copy under the mistaken assumption that the
 *  regex wasn't exported). */
function isValidAgentName(name: string): boolean {
  return SLUG_RE.test(name);
}

type NormalizeRequiredConnectorsResult =
  | { ok: true; block: Record<string, unknown> }
  | { ok: false; error: string };

/** The raw `agents` map, or the one malformed-map rejection every reader and
 *  writer shares. `map: undefined` means the manifest has no `agents:` yet. */
function agentsMapOf(
  manifest: ParsedManifest,
): { ok: true; map: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const raw = manifest.raw.agents;
  if (raw === undefined || raw === null) return { ok: true, map: undefined };
  if (Array.isArray(raw) || typeof raw !== 'object') {
    return { ok: false, error: '`agents` is malformed in this manifest (expected a map).' };
  }
  return { ok: true, map: raw as Record<string, unknown> };
}

/** One agent's raw block: null when undeclared, the plain object when not —
 *  and the one malformed-entry rejection. */
function agentBlockOf(
  agentName: string,
  entry: unknown,
): { ok: true; block: Record<string, unknown> | null } | { ok: false; error: string } {
  if (entry === undefined || entry === null) return { ok: true, block: null };
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: `agents.${agentName} is malformed (expected a table/object).` };
  }
  return { ok: true, block: entry as Record<string, unknown> };
}

/** Canonicalize both legacy alias pairs in one pass: connectors_personal →
 *  connectors_required, then kortix_cli → kortix_permissions. */
function normalizeGovernanceAliases(block: Record<string, unknown>): NormalizeRequiredConnectorsResult {
  const connectors = normalizeRequiredConnectorAliases(block);
  if (!connectors.ok) return connectors;
  return normalizeKortixPermissionAliases(connectors.block);
}

/** One grant-set write: `all` writes the keyword, `[]` writes deny-by-default
 *  by omitting the key (v2 is deny-by-default), a list writes verbatim. */
function writeGrantSet(
  block: Record<string, unknown>,
  key: string,
  value: readonly string[] | 'all' | undefined,
): void {
  if (value === undefined) return;
  if (value === 'all') block[key] = 'all';
  else if (value.length === 0) delete block[key];
  else block[key] = value;
}

function normalizeConnectorList(value: unknown, field: string): string[] | string {
  if (!Array.isArray(value)) return `${field} must be a list of connector slugs`;
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      return `${field} must contain non-empty connector slugs`;
    }
    const slug = item.trim();
    if (!normalized.includes(slug)) normalized.push(slug);
  }
  return normalized;
}

function equalConnectorSets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((slug) => rightSet.has(slug));
}

export function normalizeRequiredConnectorAliases(
  source: Record<string, unknown>,
): NormalizeRequiredConnectorsResult {
  const canonicalRaw = source.connectors_required;
  const legacyRaw = source.connectors_personal;
  const canonical =
    canonicalRaw === undefined ? undefined : normalizeConnectorList(canonicalRaw, 'connectors_required');
  if (typeof canonical === 'string') return { ok: false, error: canonical };
  const legacy =
    legacyRaw === undefined ? undefined : normalizeConnectorList(legacyRaw, 'connectors_personal');
  if (typeof legacy === 'string') return { ok: false, error: legacy };

  if (canonical && legacy && !equalConnectorSets(canonical, legacy)) {
    return {
      ok: false,
      error: 'connectors_personal must match connectors_required when both fields are present',
    };
  }

  const block = { ...source };
  delete block.connectors_personal;
  const required = canonical ?? legacy;
  if (canonicalRaw !== undefined || legacyRaw !== undefined) {
    block.connectors_required = required ?? [];
  } else {
    delete block.connectors_required;
  }
  return { ok: true, block };
}

/**
 * Canonicalize the deprecated `kortix_cli` key to `kortix_permissions` (same
 * value). Both present with different values is an error — the manifest
 * validator rejects that too. Mirrors `normalizeRequiredConnectorAliases`.
 */
function normalizeKortixPermissionAliases(
  source: Record<string, unknown>,
): NormalizeRequiredConnectorsResult {
  const legacy = source.kortix_cli;
  if (legacy === undefined) return { ok: true, block: source };
  const canonical = source.kortix_permissions;
  const block = { ...source };
  delete block.kortix_cli;
  if (canonical === undefined || canonical === null) {
    block.kortix_permissions = legacy;
    return { ok: true, block };
  }
  const key = (v: unknown) => {
    const r = resolveGrantSet(v, 'none');
    return Array.isArray(r) ? JSON.stringify([...new Set(r)].sort()) : r;
  };
  if (key(canonical) !== key(legacy)) {
    return {
      ok: false,
      error: 'kortix_cli must match kortix_permissions when both fields are present (kortix_cli is the deprecated alias)',
    };
  }
  return { ok: true, block };
}

/**
 * The agent's behavior draft from a PUT body that may name it `behavior` or,
 * before W4, `opencode`.
 *
 * GET answers both names with one value, so a round-trip client sends both
 * back and edits ONE: an older client edits `opencode`, a newer one
 * `behavior`. When they differ, the draft is the one that differs from what
 * GET served (`stored`). Two different edits are refused, never guessed.
 */
export function resolveBehaviorDraft<T extends Record<string, unknown>>(
  names: { behavior?: T; opencode?: T },
  stored: Record<string, unknown>,
): { ok: true; draft: T | undefined } | { ok: false; error: string } {
  const { behavior, opencode } = names;
  if (behavior === undefined || opencode === undefined || isDeepStrictEqual(behavior, opencode)) {
    return { ok: true, draft: behavior ?? opencode };
  }
  if (isDeepStrictEqual(behavior, stored)) return { ok: true, draft: opencode };
  if (isDeepStrictEqual(opencode, stored)) return { ok: true, draft: behavior };
  return {
    ok: false,
    error: 'behavior and opencode differ; send the agent behavior once, as behavior (opencode is its deprecated name)',
  };
}

function pruneRequiredConnectors(block: Record<string, unknown>): void {
  const required = block.connectors_required;
  if (!Array.isArray(required)) return;
  const connectors = resolveGrantSet(block.connectors, 'none');
  if (connectors === 'all') return;
  const granted = new Set(connectors === 'none' ? [] : connectors);
  const kept = required.filter(
    (value): value is string => typeof value === 'string' && granted.has(value),
  );
  if (kept.length > 0) block.connectors_required = kept;
  else delete block.connectors_required;
}

type ReadAgentBlockResult =
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
  const defaultAgentRaw = manifest.raw.default_agent;
  const defaultAgent =
    typeof defaultAgentRaw === 'string' && defaultAgentRaw.trim() ? defaultAgentRaw.trim() : null;
  const agents = agentsMapOf(manifest);
  if (!agents.ok) return agents;
  const entry = agentBlockOf(agentName, agents.map?.[agentName]);
  if (!entry.ok) return entry;
  if (!entry.block) {
    return { ok: true, schemaVersion: 2, block: null, defaultAgent };
  }
  const aliases = normalizeGovernanceAliases(entry.block);
  if (!aliases.ok) return aliases;
  const repository = normalizeRepositoryAccess(aliases.block, true);
  if (!repository.ok) return repository;
  return {
    ok: true,
    schemaVersion: 2,
    block: repository.block as AgentBlockV2,
    defaultAgent,
  };
}

/** Canonicalize supported legacy modes without granting access or enabling legacy read. */
function normalizeRepositoryAccess(block: Record<string, unknown>, reading = false): NormalizeRequiredConnectorsResult {
  const next = { ...block };
  if (next.repository_access !== undefined && typeof next.repository_access !== 'boolean') {
    return { ok: false, error: 'repository_access must be a boolean' };
  }
  if (next.workspace !== undefined) {
    if (!['runtime', 'read', 'branch'].includes(String(next.workspace))) {
      return { ok: false, error: 'workspace must be runtime, read, or branch' };
    }
    const access = next.workspace === 'branch';
    if (next.repository_access !== undefined && next.repository_access !== access) {
      return { ok: false, error: 'repository_access conflicts with workspace' };
    }
    if (next.workspace !== 'read' || next.repository_access !== undefined || reading) {
      next.repository_access ??= access;
      delete next.workspace;
    }
  }
  return { ok: true, block: next };
}

export type ApplyAgentBlockResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string; issues?: ManifestIssue[] };

function applyAgentMapBlock(
  manifest: ParsedManifest,
  agentName: string,
  block: Record<string, unknown>,
): ApplyAgentBlockResult {
  if (!isValidAgentName(agentName)) {
    return {
      ok: false,
      error: `"${agentName}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`,
    };
  }
  const agents = agentsMapOf(manifest);
  if (!agents.ok) return agents;
  const aliases = normalizeGovernanceAliases(block);
  if (!aliases.ok) return aliases;
  pruneRequiredConnectors(aliases.block);
  const nextAgents: Record<string, unknown> = { ...agents.map };
  const repository = normalizeRepositoryAccess(aliases.block);
  if (!repository.ok) return repository;
  // Older API replicas ignore repository_access. Keep their deny signal during rollout and rollback.
  if (repository.block.repository_access === false) repository.block.workspace = 'runtime';
  nextAgents[agentName] = repository.block;
  const nextRaw = { ...manifest.raw, agents: nextAgents };

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
 * Change the project-wide default agent without touching any agent block.
 * The manifest validator is the authority: the target must be a declared,
 * enabled map-based agent before the caller is allowed to commit the file.
 */
export function applyDefaultAgentV2(
  manifest: ParsedManifest,
  agentName: string,
): ApplyAgentBlockResult {
  if (manifest.schemaVersion !== 2) {
    return {
      ok: false,
      error:
        'This project must use kortix_version 2 (kortix.yaml) to set a project default agent.',
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
 * a malformed permission tree, unknown enum, or ungrantable `kortix_permissions`
 * action is a clean rejection here, never a broken manifest on disk.
 *
 * Refuses outright on a v1 manifest — the full v2 field space (permission
 * trees, per-field governance) has no v1 representation to fall back to;
 * the caller degrades in the UI instead of ever reaching this function for
 * a v1 project.
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
  return applyAgentMapBlock(manifest, agentName, block as Record<string, unknown>);
}

/**
 * Apply a secrets/connectors SCOPE edit to an `agents:` map manifest — the
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
  scope: {
    env?: string[] | 'all';
    connectors?: string[] | 'all';
    connectorsRequired?: string[];
    /** Kortix App slugs, same grant-set shape as `connectors`. */
    apps?: string[] | 'all';
  },
): ApplyAgentBlockResult & { notFound?: boolean } {
  if (manifest.schemaVersion !== 2) {
    return {
      ok: false,
      error:
        'This project must use kortix_version 2 (kortix.yaml) to edit agent scope.',
    };
  }
  const rawAgents = manifest.raw.agents;
  const existing =
    rawAgents && typeof rawAgents === 'object' && !Array.isArray(rawAgents)
      ? (rawAgents as Record<string, unknown>)[agentName]
      : undefined;
  const entry = agentBlockOf(agentName, existing);
  if (!entry.ok) return entry;
  if (!entry.block) {
    return {
      ok: false,
      notFound: true,
      error: `No agent "${agentName}" declared in ${manifest.path || 'kortix.yaml'}`,
    };
  }
  const normalized = normalizeRequiredConnectorAliases(entry.block);
  if (!normalized.ok) return normalized;
  const merged: Record<string, unknown> = normalized.block;
  writeGrantSet(merged, 'secrets', scope.env);
  writeGrantSet(merged, 'connectors', scope.connectors);
  writeGrantSet(merged, 'apps', scope.apps);
  if (scope.connectorsRequired !== undefined) {
    const required = Array.from(new Set(scope.connectorsRequired));
    if (required.length === 0) delete merged.connectors_required;
    else merged.connectors_required = required;
  }
  const effectiveConnectors = merged.connectors;
  const effectiveRequired = merged.connectors_required;
  if (Array.isArray(effectiveRequired)) {
    if (effectiveConnectors === undefined || effectiveConnectors === 'none') {
      delete merged.connectors_required;
    } else if (Array.isArray(effectiveConnectors)) {
      const granted = new Set(effectiveConnectors as string[]);
      const kept = (effectiveRequired as string[]).filter((slug) => granted.has(slug));
      if (kept.length === 0) delete merged.connectors_required;
      else merged.connectors_required = kept;
    }
  }
  return applyAgentMapBlock(manifest, agentName, merged);
}

/** Grant membership. Case-insensitive, mirroring `listAdmits`
 *  (../../secrets/strategy.ts) and `grantAdmits` (./serializers.ts) — a
 *  hand-written `secrets:` list in kortix.yaml may use any case, and all three
 *  answers must agree or the UI and the delivery gate disagree about whether a
 *  secret is granted. */
function listAdmits(list: readonly string[], identifier: string): boolean {
  const target = identifier.toUpperCase();
  return list.some((entry) => entry.toUpperCase() === target);
}

type GrantSecretToAgentResult =
  | {
      ok: true;
      raw: Record<string, unknown>;
      /** The list already admitted the identifier — the caller must NOT commit. */
      alreadyGranted: boolean;
      adoptedGovernance: boolean;
    }
  | { ok: false; error: string; issues?: ManifestIssue[]; unsupportedV1?: boolean };

/**
 * Add ONE secret identifier to ONE agent's `secrets:` allowlist — the write
 * behind the "No agent can receive this secret" warning
 * (`delivery_blocked_reason: 'no_agent_grant'`, ./serializers.ts). Narrower
 * than `applyAgentScopeV2` on purpose: that route replaces a whole grant set
 * and refuses an undeclared agent, while this one only ever WIDENS, and
 * upserts the agent entry when the roster does not name it yet.
 *
 * Three behaviours here are not obvious:
 *
 * 1. **`secrets: all` is expanded, not overwritten.** `resolveSecretDelivery`
 *    withholds an `egress`/`broker` row from an `'all'` grant
 *    (`agent_grant_unscoped`), so the grant HAS to become an explicit list for
 *    the secret to arrive. Writing just this identifier would silently revoke
 *    every other project secret from the agent, so `projectIdentifiers` — what
 *    `'all'` currently resolves to — is written out alongside it. Delivery
 *    today is unchanged; only a secret added LATER now needs its own grant.
 * 2. **`adoptedGovernance` covers the absent manifest too.** `revision === null`
 *    means no manifest file exists in the repo (`loadManifestForEdit`
 *    synthesized one), so the commit publishes the project's first roster and
 *    default-denies every agent it omits (../agents.ts) — the same hazard as
 *    adding the first `agents:` block to an existing file.
 * 3. **An already-admitting list is reported, never rewritten.** The caller
 *    skips the commit, so the manifest keeps its author's ordering and casing.
 */
export function grantSecretToAgentV2(
  manifest: ParsedManifest,
  agentName: string,
  identifier: string,
  projectIdentifiers: readonly string[] = [],
): GrantSecretToAgentResult {
  if (manifest.schemaVersion !== 2) {
    return {
      ok: false,
      unsupportedV1: true,
      error:
        'This project uses a kortix_version 1 manifest (kortix.toml). Upgrade to kortix_version 2 (kortix.yaml) to grant a secret to an agent.',
    };
  }
  const agents = agentsMapOf(manifest);
  if (!agents.ok) return agents;
  const adoptedGovernance =
    (manifest.revision ?? null) === null || !agents.map || Object.keys(agents.map).length === 0;

  const entry = agentBlockOf(agentName, agents.map?.[agentName]);
  if (!entry.ok) return entry;
  if (!entry.block) {
    const applied = applyAgentBlockV2(manifest, agentName, { secrets: [identifier] });
    return applied.ok ? { ...applied, alreadyGranted: false, adoptedGovernance } : applied;
  }
  const normalized = normalizeRequiredConnectorAliases(entry.block);
  if (!normalized.ok) return normalized;
  const merged = normalized.block;

  const current = merged.secrets;
  if (Array.isArray(current)) {
    const declared = current.filter((entry): entry is string => typeof entry === 'string');
    // No commit, so nothing is adopted either.
    if (listAdmits(declared, identifier)) {
      return { ok: true, raw: manifest.raw, alreadyGranted: true, adoptedGovernance: false };
    }
    // Append to the author's entries verbatim. A non-string entry is left in
    // place for `validateManifest` to reject, never quietly dropped.
    merged.secrets = [...current, identifier];
  } else if (resolveGrantSet(current, 'none') === 'all') {
    // Every other project identifier, then the new one last so the diff reads
    // as an addition. Both filters use the same case-insensitive rule the
    // delivery gate does.
    const expanded: string[] = [];
    for (const entry of projectIdentifiers) {
      if (listAdmits([identifier], entry) || listAdmits(expanded, entry)) continue;
      expanded.push(entry);
    }
    merged.secrets = [...expanded, identifier];
  } else {
    merged.secrets = [identifier];
  }

  const applied = applyAgentMapBlock(manifest, agentName, merged);
  return applied.ok ? { ...applied, alreadyGranted: false, adoptedGovernance } : applied;
}
