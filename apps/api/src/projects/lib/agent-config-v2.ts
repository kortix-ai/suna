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
  type AgentBlockV2,
  resolveGrantSet,
  SLUG_RE,
  validateManifest,
  validateAgentMdFrontmatter,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import { createHash } from 'node:crypto';
import { extractAgents } from '../agents';
import { parseAgentMarkdown, serializeAgentMarkdown } from './agent-markdown';
import { agentMarkdownPath, KNOWN_BEHAVIOR_KEYS } from './compile-agent-config';
import { serializeManifest, type ParsedManifest } from '../triggers';

/** Slug rule for an agent name — same as every other manifest slug. Reuses
 *  `@kortix/manifest-schema`'s exported `SLUG_RE` directly (it used to be
 *  re-derived here as a local copy under the mistaken assumption that the
 *  regex wasn't exported). */
export function isValidAgentName(name: string): boolean {
  return SLUG_RE.test(name);
}

export type NormalizeRequiredConnectorsResult =
  | { ok: true; block: Record<string, unknown> }
  | { ok: false; error: string };

export type BehaviorFileState = 'exists' | 'missing' | 'read_error';

export type AgentBehaviorDraft = Record<string, unknown> & {
  prompt?: string;
};

export type AgentConfigWireBlock = AgentBlockV2 & {
  connectors_personal?: string[];
  opencode?: AgentBehaviorDraft;
};

export type ComposeAgentConfigFilesResult =
  | {
      ok: true;
      agentName: string;
      manifestPath: string;
      manifestContent: string;
      behaviorPath: string;
      behaviorMarkdown: string;
      previewRevision: string;
      files: Array<{ path: string; content: string }>;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 502;
      code: string;
      error: string;
      issues?: ManifestIssue[];
    };

export type ComposeAgentRepairBehaviorFileResult =
  | {
      ok: true;
      agentName: string;
      manifestPath: string;
      behaviorPath: string;
      behaviorMarkdown: string;
      files: Array<{ path: string; content: string }>;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 502;
      code: string;
      error: string;
      issues?: ManifestIssue[];
    };

function composeError(
  status: 400 | 404 | 409 | 502,
  code: string,
  error: string,
  issues?: ManifestIssue[],
): Extract<ComposeAgentConfigFilesResult, { ok: false }> {
  return issues ? { ok: false, status, code, error, issues } : { ok: false, status, code, error };
}

function splitAgentConfigWireBlock(
  block: AgentConfigWireBlock,
): { ok: true; governanceBlock: AgentBlockV2; behavior: AgentBehaviorDraft | null } | { ok: false; error: string } {
  const { opencode, ...governanceRaw } = block;
  const normalized = normalizeRequiredConnectorAliases(governanceRaw as Record<string, unknown>);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const governanceBlock: AgentBlockV2 = {};
  for (const [key, value] of Object.entries(normalized.block)) {
    if (value !== undefined) (governanceBlock as Record<string, unknown>)[key] = value;
  }
  return { ok: true, governanceBlock, behavior: opencode ?? null };
}

function behaviorFrontmatterFromDraft(behavior: AgentBehaviorDraft): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (behavior[key] !== undefined) frontmatter[key] = behavior[key];
  }
  return frontmatter;
}

function validateBehaviorFrontmatter(
  frontmatter: Record<string, unknown>,
  agentName: string,
): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  validateAgentMdFrontmatter(frontmatter, `agents.${agentName}`, issues);
  return issues.filter((issue) => issue.severity === 'error');
}

function previewRevision(files: Array<{ path: string; content: string }>): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function normalizeConnectorList(value: unknown, field: string): string[] | string {
  if (!Array.isArray(value)) return `${field} must be a list of connector profile slugs`;
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      return `${field} must contain non-empty connector profile slugs`;
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
  const normalized = normalizeRequiredConnectorAliases(entry as Record<string, unknown>);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    schemaVersion: 2,
    block: normalized.block as AgentBlockV2,
    defaultAgent,
  };
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
  const rawAgents = manifest.raw.agents;
  if (
    rawAgents !== undefined &&
    rawAgents !== null &&
    (Array.isArray(rawAgents) || typeof rawAgents !== 'object')
  ) {
    return { ok: false, error: '`agents` is malformed in this manifest (expected a map).' };
  }
  const normalized = normalizeRequiredConnectorAliases(block);
  if (!normalized.ok) return normalized;
  pruneRequiredConnectors(normalized.block);
  const nextAgents: Record<string, unknown> = {
    ...(rawAgents as Record<string, unknown> | undefined),
  };
  nextAgents[agentName] = normalized.block;
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
  return applyAgentMapBlock(manifest, agentName, block as Record<string, unknown>);
}

export function composeAgentConfigFiles(input: {
  manifest: ParsedManifest;
  agentName: string;
  block: AgentConfigWireBlock;
  existingBehaviorFile: BehaviorFileState;
}): ComposeAgentConfigFilesResult {
  const read = readAgentBlockV2(input.manifest, input.agentName);
  if (!read.ok) return composeError(400, 'manifest_malformed', read.error);
  if (read.schemaVersion !== 2) {
    return composeError(
      400,
      'v2_required',
      'This project uses a kortix_version 1 manifest. Upgrade to kortix_version 2 (kortix.yaml) to create agents.',
    );
  }
  if (read.block !== null) {
    return composeError(409, 'duplicate_agent', `Agent "${input.agentName}" already exists.`);
  }
  if (input.existingBehaviorFile === 'exists') {
    return composeError(
      409,
      'behavior_file_exists',
      `Behavior file for "${input.agentName}" already exists without a matching manifest block.`,
    );
  }
  if (input.existingBehaviorFile === 'read_error') {
    return composeError(
      502,
      'behavior_file_read',
      `Could not inspect the behavior file for "${input.agentName}".`,
    );
  }

  const split = splitAgentConfigWireBlock(input.block);
  if (!split.ok) return composeError(400, 'invalid_body', split.error);

  const behavior = split.behavior ?? {};
  const prompt = typeof behavior.prompt === 'string' ? behavior.prompt : '';
  if (!prompt.trim()) {
    return composeError(400, 'missing_prompt', 'Agent prompt is required.');
  }

  const frontmatter = behaviorFrontmatterFromDraft(behavior);
  const behaviorIssues = validateBehaviorFrontmatter(frontmatter, input.agentName);
  if (behaviorIssues.length > 0) {
    return composeError(
      400,
      'invalid_config',
      behaviorIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      behaviorIssues,
    );
  }

  const applied = applyAgentBlockV2(input.manifest, input.agentName, split.governanceBlock);
  if (!applied.ok) {
    return composeError(400, 'invalid_config', applied.error, applied.issues);
  }

  const parsedCheck = extractAgents({ ...input.manifest, raw: applied.raw });
  const parseProblem = parsedCheck.errors.find((error) => error.name === input.agentName);
  if (parseProblem) {
    return composeError(400, 'invalid_config', parseProblem.error);
  }

  const nextManifest = { ...input.manifest, raw: applied.raw };
  const manifestPath = input.manifest.path;
  const manifestContent = serializeManifest(nextManifest);
  const behaviorPath = agentMarkdownPath(applied.raw, input.agentName);
  const behaviorMarkdown = serializeAgentMarkdown(frontmatter, prompt);
  const files = [
    { path: manifestPath, content: manifestContent },
    { path: behaviorPath, content: behaviorMarkdown },
  ];

  return {
    ok: true,
    agentName: input.agentName,
    manifestPath,
    manifestContent,
    behaviorPath,
    behaviorMarkdown,
    previewRevision: previewRevision(files),
    files,
    raw: applied.raw,
  };
}

export function composeAgentRepairBehaviorFile(input: {
  manifest: ParsedManifest;
  agentName: string;
  behaviorFileState: BehaviorFileState;
  behaviorMarkdown: string;
}): ComposeAgentRepairBehaviorFileResult {
  const read = readAgentBlockV2(input.manifest, input.agentName);
  if (!read.ok) return composeError(400, 'manifest_malformed', read.error);
  if (read.schemaVersion !== 2) {
    return composeError(
      400,
      'v2_required',
      'This project uses a kortix_version 1 manifest. Upgrade to kortix_version 2 (kortix.yaml) to repair agent behavior files.',
    );
  }
  if (read.block === null) {
    return composeError(404, 'agent_not_declared', `Agent "${input.agentName}" is not declared.`);
  }
  if (input.behaviorFileState === 'exists') {
    return composeError(409, 'behavior_file_exists', `Behavior file for "${input.agentName}" already exists.`);
  }
  if (input.behaviorFileState === 'read_error') {
    return composeError(
      502,
      'behavior_file_read',
      `Could not inspect the behavior file for "${input.agentName}".`,
    );
  }
  if (!input.behaviorMarkdown.trim()) {
    return composeError(400, 'missing_behavior_markdown', 'Behavior markdown is required.');
  }

  const parsed = parseAgentMarkdown(input.behaviorMarkdown);
  const behaviorIssues = validateBehaviorFrontmatter(parsed.frontmatter, input.agentName);
  if (behaviorIssues.length > 0) {
    return composeError(
      400,
      'invalid_behavior_markdown',
      behaviorIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      behaviorIssues,
    );
  }

  const behaviorPath = agentMarkdownPath(input.manifest.raw, input.agentName);
  const behaviorMarkdown = serializeAgentMarkdown(parsed.frontmatter, parsed.body);
  return {
    ok: true,
    agentName: input.agentName,
    manifestPath: input.manifest.path,
    behaviorPath,
    behaviorMarkdown,
    files: [{ path: behaviorPath, content: behaviorMarkdown }],
  };
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
  const normalized = normalizeRequiredConnectorAliases(existing as Record<string, unknown>);
  if (!normalized.ok) return normalized;
  const merged: Record<string, unknown> = normalized.block;
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
