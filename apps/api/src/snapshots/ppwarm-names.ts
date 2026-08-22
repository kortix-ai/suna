import { createHash } from 'node:crypto';

/**
 * Naming + reap-selection for per-project COLD warm images (`kortix-ppwarm-…`),
 * the cold, provider-agnostic analogue of prod's stateful `kortix-wproj-`
 * snapshots. Pure — NO config/env/provider imports — so the selection logic is
 * unit-testable without booting the server.
 *
 * Legacy names are scoped to (project, template):
 * `kortix-ppwarm-<proj8>-<tpl8>-<hash12>`. Fast cold boot writes use the
 * data-plane-owned shape
 * `kpp2-<db12>-<project12>-<template16>-<hash16>`. The
 * distinct prefix prevents an older quota-GC replica from treating the new
 * four-segment layout as an old project/template scope during a rolling deploy.
 * See the FORMAT MIGRATION note below {@link perProjectWarmImageName} for why —
 * in short, a name scoped only to the project (the pre-existing shape) is safe
 * ONLY while a project can have at most one live warm image; the moment a second
 * template gets one, one bake's reap deletes the other's tip and vice versa —
 * an infinite mutual-rebuild loop.
 */

export const PPWARM_PREFIX = 'kortix-ppwarm-';
export const SCOPED_PPWARM_PREFIX = 'kpp2-';

const EXACT_PPWARM_IMAGE_NAME =
  /^(?:kortix-ppwarm-(?:[0-9a-f]{8}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{12})|kpp2-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{16}-[0-9a-f]{16})$/;

/** Accept only complete live ppwarm names in the scoped, current, or legacy format. */
export function isExactPpwarmImageName(name: string): boolean {
  return EXACT_PPWARM_IMAGE_NAME.test(name);
}

/**
 * A ppwarm image (re)built within this window is protected from supersession
 * reaping — by the on-bake reaper AND the quota GC's superseded-tip rule. Two
 * concurrently-live code versions (a rolling deploy; dev's ECS+EKS split-brain)
 * compute DIFFERENT base identities, so each considers the other's current warm
 * image "superseded" and deletes it on every bake — an infinite full-rebuild
 * loop (observed live 2026-07-22). A freshly-built image is by definition some
 * live runtime's current tip; leave it alone and reap it once it has actually
 * gone stale. Kept short so a hot project's genuinely superseded tips still
 * reclaim fast enough for the Daytona org snapshot quota.
 */
export const PPWARM_REAP_PROTECT_MS = 45 * 60 * 1000;

/**
 * Suffix that distinguishes the warm bake's BUILD-LOG row from the template it
 * layers on top of. `project_snapshot_builds.metadata.slug` records
 * `<template>-warm` for a warm bake, but no such template exists in
 * `sandbox_templates` — the warm image is derived, never declared. Anything that
 * feeds a build slug back into template resolution (rebuild, fix-with-agent)
 * MUST map it back first via `templateSlugFromBuildSlug`, or it resolves nothing.
 */
export const WARM_BUILD_SLUG_SUFFIX = '-warm';

/** The build-log slug recorded for `templateSlug`'s warm bake. */
export function warmBuildSlug(templateSlug: string): string {
  return `${templateSlug}${WARM_BUILD_SLUG_SUFFIX}`;
}

export function isWarmBuildSlug(slug: string): boolean {
  return slug.endsWith(WARM_BUILD_SLUG_SUFFIX);
}

/**
 * Map a build-log slug back to the template slug it was baked from. Note this is
 * ambiguous by construction: a project MAY declare a real template literally named
 * `foo-warm`. Callers must therefore try the slug verbatim FIRST and only fall
 * back to this — see `resolveTemplateForBuildSlug`.
 */
export function templateSlugFromBuildSlug(buildSlug: string): string {
  return isWarmBuildSlug(buildSlug)
    ? buildSlug.slice(0, -WARM_BUILD_SLUG_SUFFIX.length)
    : buildSlug;
}

/**
 * First 8 hex chars of the projectId with dashes stripped — the per-project scope
 * key in a ppwarm name. Matches warm-project.ts's `proj8` so the prefixes line up.
 */
export function proj8(projectId: string): string {
  return projectId.replace(/-/g, '').slice(0, 8);
}

/**
 * Mirror of `DEFAULT_SANDBOX_SLUG` (packages/shared/src/sandbox/dockerfile-layer.ts,
 * value `'default'`). This module is deliberately pure — no config/provider
 * imports — so importing the real constant (which drags in the whole Dockerfile-
 * layer renderer) is off the table; we mirror the value instead, same as
 * quota-gc-select.ts mirrors {@link PPWARM_REAP_PROTECT_MS}. It is ONLY the
 * default for {@link perProjectWarmImageName}'s `templateSlug` param, so a caller
 * that has not (yet) been updated to pass it explicitly — e.g.
 * provider-transition-service.ts's `resolvePrepIdentity`, which always targets
 * the shared default template — still lands on the SAME (project, tpl8) scope as
 * every other caller, never a silent name mismatch. If DEFAULT_SANDBOX_SLUG ever
 * changes, this must change with it.
 */
const MIRRORED_DEFAULT_TEMPLATE_SLUG = 'default';

/**
 * First 8 hex chars of sha256(templateSlug) — the per-template scope key layered
 * into a ppwarm name alongside {@link proj8}. Keyed on the STABLE template slug,
 * not on a content-addressed identity (base snapshot name / runtime fingerprint):
 * the latter moves on every runtime bump, which would make a template's own
 * predecessor tip fall OUTSIDE its own reap scope after every release — exactly
 * the kind of self-inflicted leak this migration exists to prevent, not add.
 *
 * ⚠ COLLISION HAS NO BACKSTOP, unlike proj8. 8 hex chars is a 32-bit space, the
 * same budget proj8 accepts — but a proj8 collision is caught downstream by
 * {@link excludePinnedTargets}, which cross-checks reap targets against live pins
 * by name. There is no equivalent guard for tpl8, so two distinct template slugs
 * in ONE project that collided would silently reintroduce the mutual-deletion
 * hazard this scoping exists to close.
 *
 * This is now a LIVE residual, not a hypothetical: `perProjectWarmEligible`
 * (builder.ts) mints per-template warm images for real on the providers in
 * `KORTIX_WARM_SNAPSHOT_CUSTOM_TEMPLATE_PROVIDERS` (Platinum by default). It is
 * accepted deliberately — a 32-bit space against a realistic 1-3 templates per
 * project — and widening it now would force a SECOND warm-image-invalidating
 * format migration (see the FORMAT MIGRATION note below) for a negligible risk.
 * The cheaper fix, if this ever needs closing, is to extend the pinned-target
 * guard to cover tpl8 rather than to widen the key.
 */
export function tpl8(templateSlug: string): string {
  return createHash('sha256').update(templateSlug).digest('hex').slice(0, 8);
}

function hashPrefix(parts: readonly string[], length: number): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, length);
}

function canonicalUrlPath(pathname: string): string {
  return pathname
    .replace(/%([0-9a-f]{2})/gi, (triplet, hex: string) => {
      const byte = Number.parseInt(hex, 16);
      const unreserved =
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) ||
        byte === 0x2d ||
        byte === 0x2e ||
        byte === 0x5f ||
        byte === 0x7e;
      return unreserved ? String.fromCharCode(byte) : `%${hex.toUpperCase()}`;
    })
    .replace(/\/+$/, '');
}

/**
 * Stable 12-hex ownership key for the Supabase data-plane endpoint that stores
 * project image pins. The API endpoint is more stable than DATABASE_URL: DB
 * passwords, roles, poolers, and TLS connection options cannot change it.
 * Credentials, query, hash, host casing, and one terminal DNS dot are excluded.
 * Protocol, effective port, and raw path remain part of the identity so two
 * distinct routed endpoints cannot collapse. Changing SUPABASE_PUBLIC_URL is a
 * cache-namespace migration: old images remain isolated and are not auto-reaped.
 */
export function dataPlaneScopeFromSupabaseUrl(raw: string, environment = ''): string {
  const url = new URL(raw);
  const environmentKey = environment.trim().toLowerCase();
  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = url.port || (protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '');
  const path = canonicalUrlPath(url.pathname);
  return hashPrefix([environmentKey, protocol, host, port, path], 12);
}

function scopedProjectKey(projectId: string): string {
  return hashPrefix([projectId], 12);
}

function scopedTemplateKey(templateSlug: string): string {
  return hashPrefix([templateSlug], 16);
}

/**
 * Data-plane-owned project image name. The 64-character format uses Platinum's
 * full name budget. It gives the data plane and project 48 bits, and gives the
 * user-controlled template and content keys 64 bits each. The content hash uses
 * every full identity input, not the short keys.
 */
export function scopedPerProjectWarmImageName(
  scope12: string,
  projectId: string,
  tip: string,
  baseSnapshotName: string,
  templateSlug: string,
): string {
  if (!/^[0-9a-f]{12}$/.test(scope12)) {
    throw new Error('data-plane scope must be exactly 12 lowercase hexadecimal characters');
  }
  const hash = hashPrefix(
    [scope12, projectId, templateSlug, tip, baseSnapshotName],
    16,
  );
  return (
    `${SCOPED_PPWARM_PREFIX}${scope12}-${scopedProjectKey(projectId)}-` +
    `${scopedTemplateKey(templateSlug)}-${hash}`
  );
}

/**
 * Content-addressed name for a project's COLD warm image, keyed on
 * (project, template, tip, base runtime identity). A new tip OR a runtime-
 * fingerprint bump moves the name → a fresh bake; a stale name is never served
 * for a moved tip. Mirrors warm-project.ts's `kortix-wproj-<proj8>-<hash12>`
 * naming, with an added `<tpl8>` scope segment — see the module header's FORMAT
 * MIGRATION note for why this is a hard format change, not an in-place tweak.
 *
 * `templateSlug` defaults to the platform default's slug so an un-migrated 3-arg
 * caller keeps computing the exact name `ensureSandboxImage`'s warm-HIT lookup
 * expects for the default template (see {@link MIRRORED_DEFAULT_TEMPLATE_SLUG}).
 * Every NEW caller should pass it explicitly.
 */
export function perProjectWarmImageName(
  projectId: string,
  tip: string,
  baseSnapshotName: string,
  templateSlug: string = MIRRORED_DEFAULT_TEMPLATE_SLUG,
): string {
  const hash = createHash('sha256')
    .update(`${projectId}|${templateSlug}|${tip}|${baseSnapshotName}`)
    .digest('hex')
    .slice(0, 12);
  return `${PPWARM_PREFIX}${proj8(projectId)}-${tpl8(templateSlug)}-${hash}`;
}

/**
 * The PRE-MIGRATION name for a project's default-template warm image:
 * `kortix-ppwarm-<proj8>-<hash12>` over `projectId|tip|baseSnapshotName` (no
 * template segment, no slug in the hash).
 *
 * Exists so the warm-HIT lookup can serve an image that is already built and
 * already correct instead of re-baking the entire fleet. Without this, shipping
 * the (project, template) scoping would invalidate EVERY warm image at once —
 * ~65% of Daytona sessions currently hit one, so the release would make the first
 * session per project miss, clone cold, and kick a bake, all inside one deploy
 * window, against a hard 100-snapshot org cap. With it, a legacy image keeps
 * serving until its tip moves for real, and the fleet migrates gradually at the
 * natural rate of default-branch pushes.
 *
 * ONLY valid for the shared default template. A legacy name encodes no template,
 * and every caller that ever minted one passed the default slug, so resolving it
 * for a custom template would serve that template a DIFFERENT template's image.
 * Callers must gate on `template.isShared` — see the read path in builder.ts.
 *
 * Delete this once no legacy name can still be active anywhere (they age out via
 * quota-gc's idle/LRU rules, which match both formats).
 */
export function legacyPerProjectWarmImageName(
  projectId: string,
  tip: string,
  baseSnapshotName: string,
): string {
  const hash = createHash('sha256')
    .update(`${projectId}|${tip}|${baseSnapshotName}`)
    .digest('hex')
    .slice(0, 12);
  return `${PPWARM_PREFIX}${proj8(projectId)}-${hash}`;
}

/**
 * ── FORMAT MIGRATION ────────────────────────────────────────────────────────
 * Every ppwarm name baked before this change has the OLD shape
 * `kortix-ppwarm-<proj8>-<hash12>` (2 dash-delimited segments after the
 * prefix) — proj8 was the ONLY scope key, correct only because every caller of
 * `perProjectWarmImageName` hardcoded the shared default template, i.e. at most
 * one live tip per PROJECT. The NEW shape is
 * `kortix-ppwarm-<proj8>-<tpl8>-<hash12>` (3 segments), scoped to (project,
 * template) so a second template's warm image can never reap — or be reaped
 * by — the default's.
 *
 * The two shapes are told apart by segment count (hash12 is always exactly 12
 * lowercase hex chars, so counting is unambiguous — no content sniffing).
 * DECISION for old-format names still in the wild: they are left to
 * quota-gc-select.ts's idle-time and LRU-budget rules (which only need "is this
 * a ppwarm name", not its template) rather than matched by the on-bake reap
 * below — an old-format name has no tpl8 to safely compare, and guessing one
 * risks exactly the cross-template collision this migration closes. This is a
 * deliberate choice, not an oversight: those rules already run on every ppwarm
 * name regardless of shape, so an old-format tip is NEVER silently unreapable —
 * it just ages out on quota-gc's schedule instead of being swept the instant a
 * new tip goes active.
 *
 * ⚠ DEPLOYMENT: THIS INVALIDATES EVERY EXISTING WARM IMAGE. The name changes for
 * the default template too — a tpl8 segment is added AND templateSlug is folded
 * into the hash — so no pre-migration name can ever be recomputed. Concretely:
 * ~66% of Daytona sessions currently boot warm; on the release that carries this,
 * the first session per project MISSES, pays a cold clone, and kicks a background
 * re-bake. That is a fleet-wide bake burst against the Daytona org's hard
 * 100-snapshot cap, plus the old tips lingering until quota-gc ages them out
 * (they are no longer swept on-bake, see above) — i.e. transiently ~2x the ppwarm
 * tips per project. This is the same shape as the 2026-07-22 rebuild storm, so
 * it MUST be released behind the warm-bake pacing (WARM_BAKE_COOLDOWN_MS /
 * warmBakeRecentlyStartedCluster) and watched, not shipped blind. It is a
 * one-time cost: steady state is unchanged.
 */
export type ParsedPpwarmName =
  | {
      format: 'legacy';
      dataPlaneScope: null;
      projectKey: string;
      templateKey: null;
    }
  | {
      format: 'unscoped';
      dataPlaneScope: null;
      projectKey: string;
      templateKey: string;
    }
  | {
      format: 'scoped';
      dataPlaneScope: string;
      projectKey: string;
      templateKey: string;
    };

/** Parse a `kortix-ppwarm-…` name into its scope key(s). Returns null for
 *  anything outside the ppwarm namespace. See the FORMAT MIGRATION note above. */
export function parseExactPpwarmImageName(name: string): ParsedPpwarmName | null {
  if (!isExactPpwarmImageName(name)) return null;
  if (name.startsWith(SCOPED_PPWARM_PREFIX)) {
    const segments = name.slice(SCOPED_PPWARM_PREFIX.length).split('-');
    const [dataPlaneScope, projectKey, templateKey] = segments;
    return dataPlaneScope && projectKey && templateKey
      ? { format: 'scoped', dataPlaneScope, projectKey, templateKey }
      : null;
  }
  const segments = name.slice(PPWARM_PREFIX.length).split('-');
  if (segments.length === 2) {
    const [p] = segments;
    return p
      ? { format: 'legacy', dataPlaneScope: null, projectKey: p, templateKey: null }
      : null;
  }
  if (segments.length === 3) {
    const [p, t] = segments;
    return p && t
      ? { format: 'unscoped', dataPlaneScope: null, projectKey: p, templateKey: t }
      : null;
  }
  return null;
}

/**
 * Pure selector for the on-bake reap: given every snapshot/template name the
 * provider knows, return this project's SUPERSEDED per-project warm names for
 * the SAME TEMPLATE as `currentName` — never another template's tip (the
 * mutual-deletion hazard this migration closes) and never an old-format name
 * (see the FORMAT MIGRATION note; those are left to quota-gc-select.ts). The
 * shared base (`kortix-default-…`) never carries the ppwarm prefix so it's
 * never a target; returns [] when only the current tip exists (idempotent
 * re-bake). Tombstones are excluded: Platinum's delete is a soft-delete that
 * renames the row to `…__deleted_<id>` while KEEPING the ppwarm prefix, so an
 * already-reaped tip would otherwise be re-selected (and re-DELETEd) on every
 * later bake; those rows are already deprecated / not quota-counting, so there
 * is nothing to reap.
 *
 * `currentName` is expected to be NEW-format (every real caller now mints one
 * via {@link perProjectWarmImageName}). If it is somehow OLD-format instead,
 * this degrades to the pre-migration proj8-only scope, byte-identical to the
 * original behavior — a defensive fallback, not a path any current caller takes.
 */
export function ppwarmReapTargets(projectId: string, currentName: string, allNames: string[]): string[] {
  const proj = proj8(projectId);
  const current = parseExactPpwarmImageName(currentName);

  // Reaping is destructive. An unrecognised current name provides no safe
  // ownership boundary, so it must never fall back to prefix matching.
  if (!current) return [];

  if (current?.format === 'scoped') {
    if (current.projectKey !== scopedProjectKey(projectId)) return [];
    return allNames.filter((name) => {
      if (name === currentName || name.includes('__deleted')) return false;
      const parsed = parseExactPpwarmImageName(name);
      return (
        parsed?.format === 'scoped' &&
        parsed.dataPlaneScope === current.dataPlaneScope &&
        parsed.projectKey === current.projectKey &&
        parsed.templateKey === current.templateKey
      );
    });
  }

  if (current.projectKey !== proj) return [];

  if (current?.format === 'unscoped') {
    return allNames.filter((n) => {
      if (n === currentName || n.includes('__deleted')) return false;
      const parsed = parseExactPpwarmImageName(n);
      return (
        parsed?.format === 'unscoped' &&
        parsed.projectKey === proj &&
        parsed.templateKey === current.templateKey
      );
    });
  }

  // OLD-format currentName: pre-migration proj8-only scope.
  const prefix = `${PPWARM_PREFIX}${proj}-`;
  return allNames.filter((name) => {
    if (!name.startsWith(prefix) || name === currentName || name.includes('__deleted')) return false;
    const parsed = parseExactPpwarmImageName(name);
    return parsed?.format === 'legacy' || parsed?.format === 'unscoped';
  });
}

/**
 * FIX-K-lite guard: drop any reap target that is the ACTIVE pinned image (by name)
 * of SOME project. proj8 is only the first 8 hex of the projectId, so the
 * prefix-scoped {@link ppwarmReapTargets} can collide with another project whose id
 * shares those 8 hex; cross-checking against the live pins makes such a collision
 * harmless (worst case, a superseded tip is kept one extra cycle).
 */
export function excludePinnedTargets(targets: string[], pinnedImages: ReadonlySet<string>): string[] {
  return targets.filter((name) => !pinnedImages.has(name));
}
