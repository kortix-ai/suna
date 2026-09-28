import type { Project } from '@kortix/api-contract';
import type { projects } from '@kortix/db';
import { type SandboxProviderName, config } from '../../config';
import { buildFeatureFlagCatalog, resolveFeatureFlags } from '../../feature-flags/registry';
import type { ProjectRole } from '../access';
import { normalizeProjectGlyph } from './project-glyph';
import { normalizeProjectIcon } from './project-icon';
import { proxyGitUrl } from './sessions';

type ProjectRow = typeof projects.$inferSelect;

function dashboardBaseUrl(): string {
  return (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
}

/** True when a GitHub repo-create error is a name collision (HTTP 422). On
 *  POST /user/repos a 422 is, in practice, always "name already exists". */

export function serializeProject(
  row: ProjectRow,
  access?: { projectRole: ProjectRole | null; effectiveRole: ProjectRole },
): Project {
  return {
    project_id: row.projectId,
    account_id: row.accountId,
    name: row.name,
    repo_url: row.repoUrl,
    // Runtime clients clone and push only through the Kortix Git proxy. The
    // upstream origin and its credential remain server-side.
    git_origin_url: proxyGitUrl(row.projectId),
    default_branch: row.defaultBranch,
    manifest_path: row.manifestPath,
    status: row.status,
    metadata: publicProjectMetadata(row.metadata),
    // Per-project emoji, stored in metadata (no migration — same mechanism as
    // default_sandbox_provider below and metadata.onboarding_completed_at).
    // Re-validated on read so a value written before the validator existed, or
    // written directly to the DB, can never reach the UI unchecked.
    icon: normalizeProjectIcon((row.metadata as Record<string, unknown> | null | undefined)?.icon),
    icon_glyph: normalizeProjectGlyph(
      (row.metadata as Record<string, unknown> | null | undefined)?.icon_glyph,
    ),
    last_opened_at: row.lastOpenedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    project_role: access?.projectRole ?? null,
    effective_project_role: access?.effectiveRole ?? null,
    dashboard_url: `${dashboardBaseUrl()}/projects/${row.projectId}`,
    // Feature flags (Settings → Feature flags) — `experimental` is the effective
    // on/off map; `experimental_features` is the self-describing catalog the UI
    // renders from. Both wire names are historical and STABLE; do not rename
    // them. SoT = ../../feature-flags/registry.
    experimental: resolveFeatureFlags(row.metadata),
    experimental_features: buildFeatureFlagCatalog(row.metadata),
    // Per-project sandbox-provider override (Customize → Settings). `default_sandbox_provider`
    // is the current pin (null = follow the platform default/distribution);
    // `available_sandbox_providers` is the enabled set the picker offers
    // (ALLOWED ∩ has-API-key) — the web client renders + validates against the SAME
    // set the backend enforces, without a separate (billing-gated) providers route.
    // Surface the pin only when it's still USABLE (allowed + key) — mirrors the
    // create path (which ignores a disabled/removed pin and falls back), so the
    // picker never shows a value with no matching option.
    default_sandbox_provider: ((): SandboxProviderName | null => {
      const pin = (row.metadata as Record<string, unknown> | null | undefined)
        ?.default_sandbox_provider;
      if (
        typeof pin !== 'string' ||
        !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(pin)
      ) {
        return null;
      }

      const provider = pin as SandboxProviderName;
      return config.isProviderEnabled(provider) ? provider : null;
    })(),
    available_sandbox_providers: config.ALLOWED_SANDBOX_PROVIDERS.filter((p) =>
      config.isProviderEnabled(p),
    ),
  };
}

export function publicProjectMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const source = metadata as Record<string, unknown>;
  if (!source.git || typeof source.git !== 'object') return source;
  const git = source.git as Record<string, unknown>;
  if (!Object.hasOwn(git, 'fast_boot')) return source;
  const { fast_boot: _fastBoot, ...publicGit } = git;
  return { ...source, git: publicGit };
}
