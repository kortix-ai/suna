/**
 * Craft extraction — the `crafts:` block of a project manifest.
 *
 * A craft is a GitHub repo whose own `kortix.yaml` declares agents, triggers
 * and connectors. Installing one MERGES that declaration into the target
 * project, and records the merge as a `crafts:` entry. That entry is why
 * `git revert` is a working uninstall: the record and the entities it names
 * land in one commit.
 *
 * This module is the read side, and it is deliberately the same shape as
 * `extractTriggers` in `./triggers.ts`: never throws, returns per-entry parse
 * errors alongside the good specs so the UI can render a broken craft next to
 * a healthy one. It is a leaf — no config, no db — so the parse rules are
 * unit-testable without booting the API's env graph.
 *
 * Validation split, mirroring the trigger reader:
 *   - SHAPE is enforced here (slug, `owner/repo`, the `owns` map).
 *   - The cross-field rule — every `craft:` back-reference on a trigger /
 *     connector / agent must name an entry here — belongs to
 *     `@kortix/manifest-schema`'s `validateCraftRefsV2` at the CR-merge gate.
 *     A dangling reference must never take a trigger offline at runtime.
 */

import { CRAFT_OWNED_KINDS, CRAFT_REPO_RE } from '@kortix/manifest-schema';
import { MANIFEST_FILENAME, type ParsedManifest } from './triggers';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** What one craft contributed, by entity kind. Keys are `CRAFT_OWNED_KINDS`. */
export type CraftOwned = Partial<Record<(typeof CRAFT_OWNED_KINDS)[number], string[]>>;

/** One installed craft, as the manifest records it. */
export interface CraftEntrySpec {
  /** The craft's identity within this project. Unique per manifest. */
  slug: string;
  /** `<manifest-file>#crafts.<slug>` — a breadcrumb for the UI, never routing. */
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
  /** Summary of what this craft contributed — what uninstall must remove. */
  owns: CraftOwned;
}

export interface CraftParseError {
  slug: string;
  path: string;
  error: string;
}

export interface LoadedCrafts {
  specs: CraftEntrySpec[];
  errors: CraftParseError[];
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

function parseOwned(value: unknown): CraftOwned {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const owned: CraftOwned = {};
  for (const kind of CRAFT_OWNED_KINDS) {
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
 * Parse the `crafts:` list out of a loaded manifest, validating each entry.
 * Never throws — a bad entry lands in `errors` with a slug and a reason.
 */
export function extractCrafts(manifest: ParsedManifest): LoadedCrafts {
  const filename = manifest.path || MANIFEST_FILENAME;
  const raw = manifest.raw.crafts;
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
              ? '`crafts` must be a list — write it as a YAML `crafts:` list, not a map or scalar.'
              : '`crafts` must be an array of tables — use [[crafts]], not [crafts]',
        },
      ],
    };
  }

  const specs: CraftEntrySpec[] = [];
  const errors: CraftParseError[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const fail = (slug: string, error: string) => errors.push({ slug, path: filename, error });

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('(invalid)', `crafts entry #${index + 1} is not a table`);
      return;
    }
    const row = entry as Record<string, unknown>;

    const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
    if (!slug) {
      fail(`(index-${index})`, `crafts entry #${index + 1} is missing a slug`);
      return;
    }
    if (!SLUG_RE.test(slug)) {
      fail(slug, `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`);
      return;
    }
    if (seen.has(slug)) {
      fail(slug, `Duplicate craft slug "${slug}" — two crafts cannot claim one identity`);
      return;
    }

    const repo = typeof row.repo === 'string' ? row.repo.trim() : '';
    if (!repo) {
      fail(slug, 'repo is required — a craft always records where it came from');
      return;
    }
    if (!CRAFT_REPO_RE.test(repo)) {
      fail(slug, `repo must be "owner/repo" (got "${repo}")`);
      return;
    }
    const [repoOwner, repoName] = repo.split('/');

    seen.add(slug);
    specs.push({
      slug,
      path: `${filename}#crafts.${slug}`,
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

// ── per-craft trigger activation ────────────────────────────────────────────

/**
 * Flip `enabled` on every trigger this craft owns, in the manifest.
 *
 * PURE — takes a manifest, returns a new one. The route wraps it in
 * `mutateManifestWithRetry`, so one call produces one commit no matter how
 * many triggers the craft contributed.
 *
 * Why this and not `setProjectTriggersActivation`: that switch is the
 * PROJECT-WIDE pause (`projects.metadata.triggers.paused`) — it stops
 * everything at once and is a kill switch, not an enable. A craft owns a subset
 * of the project's triggers, and turning that subset on must not disturb a
 * hand-authored trigger sitting beside it.
 *
 * The join is the manifest's own `craft:` field, not `owns.triggers`. Both are
 * written at install, and when they disagree `craft:` on the entry is the one
 * that decides — it is what the runtime reconciler materializes into
 * `project_trigger_runtime.craft_slug`, which is what attributes a RUN. Reading
 * `owns` here would let a hand-edit enable a trigger whose runs report under a
 * different craft.
 *
 * Returns the slugs it actually changed. An empty list means the manifest was
 * already in the requested state, which the route reports as a no-op rather
 * than an empty commit.
 */
export function setCraftTriggersEnabled(
  manifest: ParsedManifest,
  craftSlug: string,
  enabled: boolean,
): { manifest: ParsedManifest; changed: string[] } {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const changed: string[] = [];
  const next = current.map((entry) => {
    if (entry?.craft !== craftSlug) return entry;
    // An entry with no `enabled` key is enabled by default (see
    // `parseTriggerEntry`), so "already enabled" must treat absent as true or
    // enabling would rewrite every entry and produce a no-change commit.
    const currentlyEnabled = entry.enabled !== false;
    if (currentlyEnabled === enabled) return entry;
    changed.push(String(entry.slug ?? ''));
    return { ...entry, enabled };
  });
  if (changed.length === 0) return { manifest, changed };
  return { manifest: { ...manifest, raw: { ...manifest.raw, triggers: next } }, changed };
}
