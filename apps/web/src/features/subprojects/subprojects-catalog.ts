import type { Subproject as SdkSubproject, SubprojectConnectorSummary, InstalledSubproject } from '@kortix/sdk';

/**
 * The subproject view model — a thin adapter over the SDK's `Subproject`.
 *
 * This module used to hold a hardcoded nine-entry array for the UI phase. It
 * now holds no data at all: the store reads `useSubprojects()`, and everything below
 * is derivation the components need and the API does not send.
 *
 * It is deliberately SERVER-SAFE — no icon values, no React. The tile lives in
 * `./subproject-visual.ts`, which is client-graph only because Phosphor's main entry
 * calls `createContext` at module scope. That split is what lets a server
 * component read a subproject.
 */

/** The wire shape, re-exported so components import one name. */
export type Subproject = SdkSubproject;

/**
 * One app a subproject needs, as the install modal lists it.
 *
 * Two keys, deliberately, because they answer different questions:
 *
 *  - `id` is the Composio toolkit slug (`gmail`, `linear`). It keys the LOGO,
 *    and a subproject may name a toolkit we ship no mark for.
 *  - `slug` is the manifest's connector name. It is what a project's own
 *    connector will be called after the install, so it — not `id` — is the key
 *    that decides whether the project already has this connector.
 *
 * Merging them would break one case or the other: a subproject that requires `gmail`
 * under the alias `inbox` has a Gmail logo and a connector named `inbox`.
 */
export interface SubprojectConnectorRow {
  /** Toolkit slug for the logo mark. Falls back to `slug`. */
  id: string;
  /** The manifest connector name — the key a project connector matches on. */
  slug: string;
  /** Display name. */
  label: string;
}

/**
 * `owner/repo` for a github subproject, or the archive name for an upload.
 *
 * The API already computes this — an upload has NULL repo columns, and joining
 * them client-side would render "null/null". Reading `subproject.repo` keeps one
 * answer on both sides.
 */
export const subprojectRepoSlug = (subproject: Subproject): string => subproject.repo;

/**
 * Link-out target for the modal's provenance row, or null when there is
 * nowhere to go. An uploaded subproject has no repository — the row must state that
 * rather than link to a 404.
 */
export function subprojectRepoUrl(subproject: Subproject): string | null {
  if (subproject.source_kind !== 'github' || !subproject.repo_owner || !subproject.repo_name) return null;
  return `https://github.com/${subproject.repo_owner}/${subproject.repo_name}`;
}

/** True when this subproject came from an uploaded archive rather than a repo. */
export const subprojectIsUpload = (subproject: Subproject): boolean => subproject.source_kind === 'upload';

/** Compact count for card meta — `2431` renders `2.4k`, `986` stays `986`. */
export const formatCount = (n: number): string =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/**
 * Map the API's connector requirements onto rows.
 *
 * The mock carried a `role` per connector ("reads issues", "opens the upgrade
 * PR"). A `kortix.yaml` declares no such field, so rather than invent one the
 * row shows the app's own name and leaves the trailing edge for the project's
 * connection state — which is a fact, unlike a made-up role.
 */
export function subprojectConnectorRows(subproject: Subproject): SubprojectConnectorRow[] {
  return (subproject.connectors ?? []).map((connector: SubprojectConnectorSummary) => {
    const slug = (connector.slug ?? '').toLowerCase();
    const id = (connector.app ?? slug).toLowerCase();
    return { id, slug, label: connector.slug || id };
  });
}

/** Client-side search over the fields a person would type. */
export function subprojectMatchesQuery(subproject: Subproject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    subproject.title.toLowerCase().includes(q) ||
    (subproject.description ?? '').toLowerCase().includes(q) ||
    subproject.repo.toLowerCase().includes(q) ||
    subproject.slug.toLowerCase().includes(q)
  );
}

// ── counting things ─────────────────────────────────────────────────────────

/**
 * `3 agents` / `1 agent`. Takes the SINGULAR and adds the `s`.
 *
 * There were eight hand-rolled `count === 1 ? '' : 's'` ternaries across this
 * feature and one place that forgot — the installed row rendered "1 agents",
 * because it printed the `owns` KEY, which is already plural.
 */
export function countLabel(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** What one `owns` kind is called in the singular. */
type OwnedKind = keyof NonNullable<InstalledSubproject['owns']>;

/**
 * Singular label per `owns` key.
 *
 * Explicit rather than trimming a trailing `s`: the keys come from
 * `SUBPROJECT_OWNED_KINDS`, and a future kind like `policies` would have to read
 * "policy" — a trim would say "policie". Typed as a total `Record`, so adding a
 * kind to the manifest schema fails the build here instead of shipping a wrong
 * label.
 */
const OWNED_KIND_SINGULAR: Record<OwnedKind, string> = {
  agents: 'agent',
  skills: 'skill',
  connectors: 'connector',
  triggers: 'trigger',
};

/** `1 agent`, `3 skills` — for the installed row's contribution summary. */
export function subprojectOwnsLabel(kind: string, count: number): string {
  const singular = OWNED_KIND_SINGULAR[kind as OwnedKind];
  // An unknown key is possible: `owns` comes from a committed manifest, which a
  // person can hand-edit. Print it as-is rather than guessing at English.
  return singular ? countLabel(count, singular) : `${count} ${kind}`;
}
