/**
 * Subproject extraction — the `subprojects:` block of a project manifest.
 *
 * A subproject is a GitHub repo whose own `kortix.yaml` declares agents, triggers
 * and connectors. Installing one MERGES that declaration into the target
 * project, and records the merge as a `subprojects:` entry. That entry is why
 * `git revert` is a working uninstall: the record and the entities it names
 * land in one commit.
 *
 * This module is the read side, and it is deliberately the same shape as
 * `extractTriggers` in `./triggers.ts`: never throws, returns per-entry parse
 * errors alongside the good specs so the UI can render a broken subproject next to
 * a healthy one. It is a leaf — no config, no db — so the parse rules are
 * unit-testable without booting the API's env graph.
 *
 * Validation split, mirroring the trigger reader:
 *   - SHAPE is enforced here (slug, `owner/repo`, the `owns` map).
 *   - The cross-field rule — every `subproject:` back-reference on a trigger /
 *     connector / agent must name an entry here — belongs to
 *     `@kortix/manifest-schema`'s `validateSubprojectRefsV2` at the CR-merge gate.
 *     A dangling reference must never take a trigger offline at runtime.
 */

import { SUBPROJECT_OWNED_KINDS, SUBPROJECT_REPO_RE } from '@kortix/manifest-schema';
import { MANIFEST_FILENAME, type ParsedManifest } from './triggers';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** What one subproject contributed, by entity kind. Keys are `SUBPROJECT_OWNED_KINDS`. */
export type SubprojectOwned = Partial<Record<(typeof SUBPROJECT_OWNED_KINDS)[number], string[]>>;

/** One installed subproject, as the manifest records it. */
export interface SubprojectEntrySpec {
  /** The subproject's identity within this project. Unique per manifest. */
  slug: string;
  /** `<manifest-file>#subprojects.<slug>` — a breadcrumb for the UI, never routing. */
  path: string;
  /** Repo owner, from the `owner/repo` the entry declares. */
  repoOwner: string;
  /** Repo name, from the same. */
  repoName: string;
  /**
   * The git ref the install asked for — a branch or tag. Null = the repo's
   * default branch. This is what an update re-resolves against.
   */
  gitRef: string | null;
  /**
   * The commit sha `gitRef` resolved to at install. The integrity source, and
   * what "this version" means — a branch moves, a sha does not.
   */
  resolvedSha: string | null;
  /** Display-only tag (`v1.2.0`). Never the integrity source; `resolvedSha` is. */
  version: string | null;
  /** Human label; defaults to the slug when the entry sets none. */
  title: string;
  /** ISO-8601 instant the install landed, when the entry records one. */
  installedAt: string | null;
  /** Summary of what this subproject contributed — what uninstall must remove. */
  owns: SubprojectOwned;
}

export interface SubprojectParseError {
  slug: string;
  path: string;
  error: string;
}

export interface LoadedSubprojects {
  specs: SubprojectEntrySpec[];
  errors: SubprojectParseError[];
}

/** Normalize one `owns` list: keep valid slugs, drop the rest, dedupe, sort. */
function parseOwnedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (name && SLUG_RE.test(name)) out.add(name);
  }
  return [...out].sort();
}

function parseOwned(value: unknown): SubprojectOwned {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const owned: SubprojectOwned = {};
  for (const kind of SUBPROJECT_OWNED_KINDS) {
    const list = parseOwnedList(row[kind]);
    if (list.length > 0) owned[kind] = list;
  }
  return owned;
}

/** A non-empty trimmed string, or null. */
function optionalString(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

/**
 * Parse the `subprojects:` list out of a loaded manifest, validating each entry.
 * Never throws — a bad entry lands in `errors` with a slug and a reason.
 */
export function extractSubprojects(manifest: ParsedManifest): LoadedSubprojects {
  const filename = manifest.path || MANIFEST_FILENAME;
  const raw = manifest.raw.subprojects;
  if (raw === undefined || raw === null) return { specs: [], errors: [] };

  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [
        {
          slug: '(top-level)',
          path: filename,
          error:
            manifest.format === 'yaml'
              ? '`subprojects` must be a list — write it as a YAML `subprojects:` list, not a map or scalar.'
              : '`subprojects` must be an array of tables — use [[subprojects]], not [subprojects]',
        },
      ],
    };
  }

  const specs: SubprojectEntrySpec[] = [];
  const errors: SubprojectParseError[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const fail = (slug: string, error: string) => errors.push({ slug, path: filename, error });

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('(invalid)', `subprojects entry #${index + 1} is not a table`);
      return;
    }
    const row = entry as Record<string, unknown>;

    const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
    if (!slug) {
      fail(`(index-${index})`, `subprojects entry #${index + 1} is missing a slug`);
      return;
    }
    if (!SLUG_RE.test(slug)) {
      fail(slug, `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`);
      return;
    }
    if (seen.has(slug)) {
      fail(slug, `Duplicate subproject slug "${slug}" — two subprojects cannot claim one identity`);
      return;
    }

    const repo = typeof row.repo === 'string' ? row.repo.trim() : '';
    if (!repo) {
      fail(slug, 'repo is required — a subproject always records where it came from');
      return;
    }
    if (!SUBPROJECT_REPO_RE.test(repo)) {
      fail(slug, `repo must be "owner/repo" (got "${repo}")`);
      return;
    }
    const [repoOwner, repoName] = repo.split('/');

    seen.add(slug);
    specs.push({
      slug,
      path: `${filename}#subprojects.${slug}`,
      repoOwner,
      repoName,
      gitRef: optionalString(row.ref),
      resolvedSha: optionalString(row.sha),
      version: optionalString(row.version),
      title: optionalString(row.title) ?? slug,
      installedAt: optionalString(row.installed_at),
      owns: parseOwned(row.owns),
    });
  });

  return { specs, errors };
}
