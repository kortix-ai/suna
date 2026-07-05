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
  validateManifest,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import type { ParsedManifest } from '../triggers';

/** Slug rule for an agent name — same as every other manifest slug (see
 *  `@kortix/manifest-schema`'s `SLUG_RE`, kept in lockstep here since that
 *  regex isn't exported). */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
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
