import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses';
import type { AcpHarness, RuntimeProfile } from '@kortix/sdk/projects-client';

// Identity, labels, and config dirs derive from the canonical `@kortix/shared`
// harness descriptor — do not re-hardcode the harness tuple, labels, or
// config-dir strings here (see packages/shared/src/harnesses.ts).
export const ACP_HARNESSES: readonly AcpHarness[] = HARNESS_IDS;
export const ACP_HARNESS_LABELS: Record<AcpHarness, string> = Object.fromEntries(
  HARNESS_IDS.map((id) => [id, HARNESSES[id].label]),
) as Record<AcpHarness, string>;
export const ACP_HARNESS_CONFIG_DIRS: Record<AcpHarness, string> = Object.fromEntries(
  HARNESS_IDS.map((id) => [id, HARNESSES[id].configDir]),
) as Record<AcpHarness, string>;

/** Icon-provider id for `ProviderLogo`'s brand-mark lookup — one per harness. */
export const ACP_HARNESS_ICON_PROVIDER_ID: Record<AcpHarness, string> = {
  claude: 'anthropic',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

/**
 * The standalone Files route for a project (`/projects/[id]/files`, NOT a
 * Customize section — see `customize-sections.ts`'s header comment). Used by
 * the Runtime section's reframed "this runtime owns its own behavior" banner,
 * and by the agent editor's matching banner — a path out, not a dead end.
 *
 * The route doesn't support deep-linking a starting directory today (see
 * `apps/web/src/app/(app)/projects/[id]/files/page.tsx` /
 * `project-files-view.tsx` — no search-param or prop threads a path in), so
 * this links to the files root; callers name the specific directory in copy
 * instead of encoding it in the URL.
 */
export function projectFilesHref(projectId: string): string {
  return `/projects/${projectId}/files`;
}

export function withAllAcpHarnesses(
  current: Record<string, RuntimeProfile>,
): Record<string, RuntimeProfile> {
  const next = { ...current };
  for (const harness of ACP_HARNESSES) {
    if (!Object.values(next).some((profile) => profile.harness === harness)) {
      next[harness] = { harness, config_dir: ACP_HARNESS_CONFIG_DIRS[harness] };
    }
  }
  return next;
}
