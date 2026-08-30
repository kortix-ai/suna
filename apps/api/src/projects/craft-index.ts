/**
 * Craft index crawl — turn a GitHub repo into one `kortix.crafts` row.
 *
 * A craft repo needs ONLY a `kortix.yaml`. There is no `registry.json`
 * requirement: the manifest already declares the agents, triggers and
 * connectors the craft contributes, so the card is derived from it with the
 * SAME parsers the runtime uses (`extractAgents` / `extractTriggers` /
 * `extractConnectors`). That is deliberate — the store can never advertise a
 * craft the runtime would refuse to read.
 *
 * Kortix indexes; git hosts. Every derived column here is a projection of
 * public git state at one commit, and re-crawling the same
 * `(owner, repo, ref)` reproduces it.
 *
 * Order of operations matters and is not arbitrary:
 *   1. repo metadata  → default branch, stars, description
 *   2. resolve the ref → the exact commit sha
 *   3. read the manifest AT THAT SHA
 * Reading the manifest at the sha rather than at the branch is what makes the
 * cached `manifest` and `resolved_sha` columns incapable of disagreeing. Read
 * at the branch, and a push landing between steps 2 and 3 stores a manifest
 * that never existed at the recorded commit.
 */

import {
  type ManifestIssue,
  manifestCandidatePaths,
  parseCraftRepo,
  resolveGrantSet,
  validateManifest,
} from '@kortix/manifest-schema';
import { assertFetchableUrl, rawGithubUrl } from '@kortix/registry';
import { githubLoaderOptions } from '../shared/github-fetch';
import { extractAgents } from './agents';
import { extractConnectors } from './connectors';
import { extractCrafts } from './crafts';
import { extractTriggers, parseManifestString } from './triggers';

/** Stable codes so the submit route can map a failure to a status + message. */
export type CraftCrawlErrorCode =
  | 'invalid_address'
  | 'repo_not_found'
  | 'ref_not_found'
  | 'manifest_not_found'
  | 'manifest_invalid'
  | 'manifest_unsupported'
  | 'upstream_unavailable';

export class CraftCrawlError extends Error {
  constructor(
    readonly code: CraftCrawlErrorCode,
    message: string,
    /** Manifest validation findings, when `code === 'manifest_invalid'`. */
    readonly issues: ManifestIssue[] = [],
  ) {
    super(message);
    this.name = 'CraftCrawlError';
  }
}

/** One agent a craft contributes, as the store card shows it. */
export interface CraftCardAgent {
  name: string;
  description: string | null;
}

/** One trigger a craft contributes — the cadence the card advertises. */
export interface CraftCardTrigger {
  slug: string;
  name: string;
  type: string;
  cron: string | null;
  agent: string;
  enabled: boolean;
}

/** One connector a craft needs. This is a REQUIREMENT list, not a state list. */
export interface CraftCardConnector {
  slug: string;
  provider: string;
  app: string | null;
}

export interface CraftCrawlResult {
  slug: string;
  repoOwner: string;
  repoName: string;
  /** The branch/tag requested, or null when the default branch was used. */
  gitRef: string | null;
  /** The branch actually read, resolved for display when `gitRef` is null. */
  resolvedRef: string;
  resolvedSha: string;
  title: string;
  description: string | null;
  stars: number | null;
  /** The parsed manifest at `resolvedSha`. */
  manifest: Record<string, unknown>;
  agents: CraftCardAgent[];
  triggers: CraftCardTrigger[];
  connectors: CraftCardConnector[];
  skills: string[];
  envRequired: string[];
  /** The manifest path the craft's own repo uses (`kortix.yaml` etc.). */
  manifestPath: string;
  /** Non-blocking findings: warnings, plus any per-entry parse errors. */
  warnings: string[];
}

interface GithubRepoMeta {
  defaultBranch: string;
  stars: number | null;
  description: string | null;
}

const GITHUB_API = 'https://api.github.com';

/**
 * Everything the crawl touches from outside, injectable.
 *
 * `fetchImpl` defaults to the shared token-attaching, exact-hostname-matched
 * GitHub fetch (`shared/github-fetch.ts`). It is injectable for the same reason `@kortix/registry`'s
 * loader is: the crawl's semantics — candidate-path precedence, sha pinning,
 * the manifest gate, card derivation — are testable without the network, and a
 * flow test needs a deterministic repo rather than a live third party.
 */
export interface CraftCrawlOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Fetch through the marketplace's token-attaching, exact-host-matched fetch.
 *
 * `notFound` is the code a 404 OR a 422 maps to. GitHub answers an
 * unresolvable ref on `/commits/{ref}` with **422 Unprocessable Entity**, not
 * 404 — measured against the real API. Both are the caller naming something
 * that does not exist, so both must surface as an actionable 400, never as an
 * `upstream_unavailable` that reads like a server defect and pages.
 */
async function githubJson(
  url: string,
  notFound: CraftCrawlErrorCode,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  assertFetchableUrl(url);
  const res = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (res.status === 404 || res.status === 422) {
    throw new CraftCrawlError(notFound, `not found: ${url}`);
  }
  if (!res.ok) {
    throw new CraftCrawlError(
      'upstream_unavailable',
      `GitHub returned HTTP ${res.status} for ${url}`,
    );
  }
  return res.json();
}

async function readRepoMeta(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
): Promise<GithubRepoMeta> {
  const body = (await githubJson(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    'repo_not_found',
    fetchImpl,
  )) as Record<string, unknown>;
  return {
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
    stars: typeof body.stargazers_count === 'number' ? body.stargazers_count : null,
    description:
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : null,
  };
}

/** Resolve a branch/tag/sha to the exact commit sha it names right now. */
async function resolveSha(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body = (await githubJson(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
    'ref_not_found',
    fetchImpl,
  )) as Record<string, unknown>;
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!sha) {
    throw new CraftCrawlError('ref_not_found', `could not resolve ref "${ref}" to a commit`);
  }
  return sha;
}

/**
 * Read the first manifest candidate that exists, at an exact sha. Tries
 * `kortix.yaml`, `kortix.yml`, then `kortix.toml` — the same precedence
 * `manifestCandidatePaths` gives every other manifest reader in the platform.
 */
async function readManifestAtSha(
  owner: string,
  repo: string,
  sha: string,
  fetchImpl: typeof fetch,
): Promise<{ raw: string; path: string; format: 'yaml' | 'toml' }> {
  const candidates = manifestCandidatePaths(null);
  for (const candidate of candidates) {
    const url = rawGithubUrl(owner, repo, sha, candidate.path);
    assertFetchableUrl(url);
    const res = await fetchImpl(url);
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new CraftCrawlError(
        'upstream_unavailable',
        `GitHub returned HTTP ${res.status} reading ${candidate.path}`,
      );
    }
    return { raw: await res.text(), path: candidate.path, format: candidate.format };
  }
  throw new CraftCrawlError(
    'manifest_not_found',
    `no kortix.yaml in ${owner}/${repo} at ${sha.slice(0, 7)} — a craft repo must declare one (${candidates
      .map((c) => c.path)
      .join(', ')})`,
  );
}

/**
 * Which skills the craft's agents may invoke, as the union of their `skills:`
 * grants.
 *
 * Derived from the manifest rather than from a directory listing, because a
 * craft repo is only required to ship a `kortix.yaml`. The `all` / `none`
 * sentinels name no skill and contribute nothing — an `all` grant means "every
 * skill in the project it lands in", which is not a set this repo can know. A
 * craft that wants its skills advertised should grant them by name.
 *
 * Reads the raw `agents:` map rather than `AgentSpec`, because the runtime
 * parser deliberately does not surface `skills` (it compiles to the agent's
 * OpenCode `permission.skill` instead — see compile-agent-config.ts). Widening
 * `AgentSpec` for a store card would be the wrong trade.
 */
function deriveSkills(raw: Record<string, unknown>): string[] {
  const agents = raw.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return [];
  const names = new Set<string>();
  for (const block of Object.values(agents as Record<string, unknown>)) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const granted = resolveGrantSet((block as Record<string, unknown>).skills, 'none');
    if (Array.isArray(granted)) for (const name of granted) names.add(name);
  }
  return [...names].sort();
}

/** Env vars the craft declares as required. */
function deriveEnvRequired(raw: Record<string, unknown>): string[] {
  const env = raw.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [];
  const required = (env as Record<string, unknown>).required;
  if (!Array.isArray(required)) return [];
  return [
    ...new Set(
      required
        .map((v) => (typeof v === 'string' ? v.trim().toUpperCase() : ''))
        .filter((v) => v.length > 0),
    ),
  ].sort();
}

/** A craft's default slug: its repo name, lowercased into slug shape. */
export function craftSlugFromRepo(repoName: string): string {
  return (
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 128) || 'craft'
  );
}

/**
 * Crawl one repo into a craft card. Throws {@link CraftCrawlError} for every
 * expected user-input failure — a bad address, a repo with no manifest, an
 * invalid manifest — so the route can answer 400 with the reason rather than
 * letting an unexpected throw page as a server defect.
 */
export async function crawlCraftRepo(
  address: string,
  options: CraftCrawlOptions = {},
): Promise<CraftCrawlResult> {
  const fetchImpl = options.fetchImpl ?? githubLoaderOptions.fetchImpl;
  const parsed = parseCraftRepo(address);
  if (!parsed) {
    throw new CraftCrawlError(
      'invalid_address',
      `"${address}" is not a GitHub repository — use owner/repo, optionally @branch-or-tag`,
    );
  }
  const { owner, repo, ref } = parsed;

  const meta = await readRepoMeta(owner, repo, fetchImpl);
  const resolvedRef = ref ?? meta.defaultBranch;
  const resolvedSha = await resolveSha(owner, repo, resolvedRef, fetchImpl);
  const file = await readManifestAtSha(owner, repo, resolvedSha, fetchImpl);

  // The gate the CR-merge path applies, applied at submit: the store must not
  // list a craft whose manifest the platform would refuse.
  const validation = validateManifest(file.raw, file.format);
  if (!validation.valid || !validation.parsed) {
    throw new CraftCrawlError(
      'manifest_invalid',
      `${file.path} in ${owner}/${repo} is not a valid Kortix manifest`,
      validation.issues,
    );
  }

  let manifest: ReturnType<typeof parseManifestString>;
  try {
    manifest = parseManifestString(file.raw, file.format, file.path, resolvedSha);
  } catch (error) {
    // `validateManifest` passed, so this is a version the READER refuses (a
    // `kortix_version` above MAX_SCHEMA_VERSION) rather than a shape problem.
    throw new CraftCrawlError(
      'manifest_unsupported',
      error instanceof Error ? error.message : String(error),
    );
  }

  const warnings = validation.issues
    .filter((i) => i.severity === 'warning')
    .map((i) => `${i.path}: ${i.message}`);

  const agents = extractAgents(manifest);
  const triggers = extractTriggers(manifest);
  const connectors = extractConnectors(manifest);
  // A craft repo's OWN manifest should not declare installed crafts. If it
  // does, say so rather than indexing a nested install nobody will honor.
  const nested = extractCrafts(manifest);
  if (nested.specs.length > 0) {
    warnings.push(
      `crafts: ${nested.specs.length} installed-craft entr${nested.specs.length === 1 ? 'y' : 'ies'} in the source manifest are ignored — a craft does not install other crafts`,
    );
  }
  for (const e of agents.errors) warnings.push(`${e.name}: ${e.error}`);
  for (const list of [triggers.errors, connectors.errors, nested.errors]) {
    for (const e of list) warnings.push(`${e.slug}: ${e.error}`);
  }

  const projectName =
    manifest.raw.project && typeof manifest.raw.project === 'object'
      ? (manifest.raw.project as Record<string, unknown>).name
      : undefined;
  const projectDescription =
    manifest.raw.project && typeof manifest.raw.project === 'object'
      ? (manifest.raw.project as Record<string, unknown>).description
      : undefined;

  return {
    slug: craftSlugFromRepo(repo),
    repoOwner: owner,
    repoName: repo,
    gitRef: ref,
    resolvedRef,
    resolvedSha,
    // The repo name is the fallback, not the manifest's `{{projectName}}`
    // placeholder — an un-rendered starter template would otherwise become the
    // craft's title verbatim.
    title:
      typeof projectName === 'string' && projectName.trim() && !projectName.includes('{{')
        ? projectName.trim()
        : repo,
    // The manifest's own description wins over GitHub's: it describes the
    // craft, while the repo blurb describes the repository.
    description:
      typeof projectDescription === 'string' && projectDescription.trim()
        ? projectDescription.trim()
        : meta.description,
    stars: meta.stars,
    manifest: manifest.raw,
    agents: agents.specs.map((a) => ({ name: a.name, description: null })),
    triggers: triggers.specs.map((t) => ({
      slug: t.slug,
      name: t.name,
      type: t.type,
      cron: t.cron,
      agent: t.agent,
      enabled: t.enabled,
    })),
    connectors: connectors.specs.map((c) => ({
      slug: c.slug,
      provider: c.provider,
      app: c.app,
    })),
    skills: deriveSkills(manifest.raw),
    envRequired: deriveEnvRequired(manifest.raw),
    manifestPath: file.path,
    warnings,
  };
}
