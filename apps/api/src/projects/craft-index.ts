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
import { ZipReadError, readZipTextFiles } from '../shared/zip-read';
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
  | 'upstream_unavailable'
  /** The upload is not a readable ZIP archive. */
  | 'invalid_archive'
  /** The archive is readable but refused: hostile path, zip bomb, encrypted. */
  | 'archive_refused';

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

export type CraftSourceKind = 'github' | 'upload';

export interface CraftCrawlResult {
  slug: string;
  sourceKind: CraftSourceKind;
  /** Null for an upload — there is no repo. */
  repoOwner: string | null;
  repoName: string | null;
  /** The branch/tag requested, or null when the default branch was used. */
  gitRef: string | null;
  /** The branch actually read. Null for an upload. */
  resolvedRef: string | null;
  /** Null for an upload — there is no commit to pin. */
  resolvedSha: string | null;
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
  /**
   * For an upload: the craft's text files, which the install prompt embeds
   * because there is no repo to fetch from. Empty for a github craft.
   */
  files: Array<{ path: string; content: string }>;
  /** The uploaded archive's original filename, for display. Null for github. */
  uploadName: string | null;
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
 * Everything both sources compute the same way: validate the manifest, then
 * derive the card from it with the runtime's own parsers.
 *
 * Extracted so a zip and a repo can never disagree about what a craft IS. The
 * only difference between the two paths is where the bytes came from.
 */
function deriveCardFromManifest(
  raw: string,
  format: 'yaml' | 'toml',
  manifestPath: string,
  sha: string | null,
  label: string,
): {
  manifest: ReturnType<typeof parseManifestString>;
  warnings: string[];
  agents: CraftCardAgent[];
  triggers: CraftCardTrigger[];
  connectors: CraftCardConnector[];
  skills: string[];
  envRequired: string[];
  title: string | null;
  description: string | null;
} {
  const validation = validateManifest(raw, format);
  if (!validation.valid || !validation.parsed) {
    throw new CraftCrawlError(
      'manifest_invalid',
      `${manifestPath} in ${label} is not a valid Kortix manifest`,
      validation.issues,
    );
  }

  let manifest: ReturnType<typeof parseManifestString>;
  try {
    manifest = parseManifestString(raw, format, manifestPath, sha);
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
  // A craft's OWN manifest should not declare installed crafts. If it does, say
  // so rather than indexing a nested install nobody will honor.
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

  const project =
    manifest.raw.project && typeof manifest.raw.project === 'object'
      ? (manifest.raw.project as Record<string, unknown>)
      : {};
  const projectName = project.name;
  const projectDescription = project.description;

  return {
    manifest,
    warnings,
    agents: agents.specs.map((a) => ({ name: a.name, description: null })),
    triggers: triggers.specs.map((t) => ({
      slug: t.slug,
      name: t.name,
      type: t.type,
      cron: t.cron,
      agent: t.agent,
      enabled: t.enabled,
    })),
    connectors: connectors.specs.map((c) => ({ slug: c.slug, provider: c.provider, app: c.app })),
    skills: deriveSkills(manifest.raw),
    envRequired: deriveEnvRequired(manifest.raw),
    // An un-rendered `{{projectName}}` placeholder must never become a title —
    // a craft submitted straight from the starter template would otherwise be
    // listed in the store as literally "{{projectName}}".
    title:
      typeof projectName === 'string' && projectName.trim() && !projectName.includes('{{')
        ? projectName.trim()
        : null,
    description:
      typeof projectDescription === 'string' && projectDescription.trim()
        ? projectDescription.trim()
        : null,
  };
}

/**
 * Read a craft out of an uploaded ZIP archive.
 *
 * The zip is somebody's repo with no git behind it, so there is no sha to pin
 * and no raw URL to fetch from later. The craft's text files therefore travel
 * WITH the index row and get embedded in the install prompt — the same shape
 * `buildRegistryProjectInstallPrompt` already uses for a base registry item.
 * Bounded by `CRAFT_ZIP_LIMITS`: this is an installable craft, not a file host.
 */
export function crawlCraftZip(
  archive: ArrayBuffer | Uint8Array,
  uploadName: string,
): CraftCrawlResult {
  let read: ReturnType<typeof readZipTextFiles>;
  try {
    read = readZipTextFiles(archive);
  } catch (err) {
    if (err instanceof ZipReadError) {
      throw new CraftCrawlError(
        err.code === 'not_a_zip' || err.code === 'truncated'
          ? 'invalid_archive'
          : 'archive_refused',
        err.message,
      );
    }
    throw err;
  }

  const byPath = new Map(read.files.map((f) => [f.path, f.content]));
  const candidate = manifestCandidatePaths(null).find((c) => byPath.has(c.path));
  if (!candidate) {
    throw new CraftCrawlError(
      'manifest_not_found',
      `${uploadName} has no kortix.yaml at its root — a craft archive must declare one (${manifestCandidatePaths(
        null,
      )
        .map((c) => c.path)
        .join(', ')})`,
    );
  }

  const card = deriveCardFromManifest(
    byPath.get(candidate.path) as string,
    candidate.format,
    candidate.path,
    null,
    uploadName,
  );
  if (read.skipped.length > 0) {
    card.warnings.push(
      `${read.skipped.length} non-text or over-sized file(s) in the archive were not carried: ${read.skipped
        .slice(0, 8)
        .join(', ')}${read.skipped.length > 8 ? ', …' : ''}`,
    );
  }
  // Not a failure, and the common case for a whole-repo zip: a craft is its
  // manifest plus `.kortix/`, so application source is left behind on purpose.
  // Summarized rather than listed — a 900-path warning is unreadable, and the
  // number plus a sample is what tells someone whether the filter did what they
  // expected.
  if (read.ignored.length > 0) {
    card.warnings.push(
      `${read.ignored.length} file(s) are not part of a craft and were left behind — a craft is its ` +
        `kortix.yaml plus .kortix/ (agents and skills). Ignored, for example: ${read.ignored
          .slice(0, 5)
          .join(', ')}${read.ignored.length > 5 ? ', …' : ''}`,
    );
  }

  // The archive name is the only identity an upload has. Strip the extension
  // and any GitHub `-main` / `-<sha>` suffix its wrapper directory implies.
  const base = (read.root ?? uploadName.replace(/\.zip$/i, '')).replace(
    /-(?:main|master|[0-9a-f]{7,40})$/i,
    '',
  );

  return {
    slug: craftSlugFromRepo(base),
    sourceKind: 'upload',
    repoOwner: null,
    repoName: null,
    gitRef: null,
    resolvedRef: null,
    resolvedSha: null,
    title: card.title ?? craftSlugFromRepo(base),
    description: card.description,
    stars: null,
    manifest: card.manifest.raw,
    agents: card.agents,
    triggers: card.triggers,
    connectors: card.connectors,
    skills: card.skills,
    envRequired: card.envRequired,
    manifestPath: candidate.path,
    files: read.files.map((f) => ({ path: f.path, content: f.content })),
    uploadName,
    warnings: card.warnings,
  };
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
  // list a craft whose manifest the platform would refuse. Shared with the zip
  // path so a repo and an archive can never disagree about what a craft IS.
  const card = deriveCardFromManifest(
    file.raw,
    file.format,
    file.path,
    resolvedSha,
    `${owner}/${repo}`,
  );

  return {
    slug: craftSlugFromRepo(repo),
    sourceKind: 'github',
    repoOwner: owner,
    repoName: repo,
    gitRef: ref,
    resolvedRef,
    resolvedSha,
    // The repo name is the fallback when the manifest names no project.
    title: card.title ?? repo,
    // The manifest's own description wins over GitHub's: it describes the
    // craft, while the repo blurb describes the repository.
    description: card.description ?? meta.description,
    stars: meta.stars,
    manifest: card.manifest.raw,
    agents: card.agents,
    triggers: card.triggers,
    connectors: card.connectors,
    skills: card.skills,
    envRequired: card.envRequired,
    manifestPath: file.path,
    // A github craft's files are fetched at `resolvedSha` when it installs, so
    // the index stores a manifest and nothing else. Kortix indexes; git hosts.
    files: [],
    uploadName: null,
    warnings: card.warnings,
  };
}
