/**
 * The project-upgrade registry — every one-off, agent-run upgrade the
 * Upgrades section can offer. An upgrade is nothing but a detection rule and
 * a seed prompt: running one mints a fresh session, the project's default
 * agent makes the change, and the result lands as a change request for human
 * review (never merged by the agent). Adding a new upgrade = adding an entry
 * here; the view renders whatever is applicable.
 */

import type { ManifestVersion } from './manifest-version';
import { MIGRATE_TO_V2_PROMPT } from './migration-prompt';

export interface ProjectUpgradeContext {
  /** `null` while the manifest read hasn't resolved. */
  manifestVersion: ManifestVersion | null;
}

export interface ProjectUpgrade {
  id: string;
  title: string;
  description: string;
  applicable: (ctx: ProjectUpgradeContext) => boolean;
  prompt: string;
}

export const PROJECT_UPGRADES: readonly ProjectUpgrade[] = [
  {
    id: 'manifest-v2',
    title: 'Migrate manifest to v2 (kortix.yaml)',
    description:
      'Converts the v1 kortix.toml into the governance-first kortix.yaml, refreshes platform-managed skills to the latest marketplace baseline, and opens a change request for review.',
    applicable: (ctx) => ctx.manifestVersion === 1,
    prompt: MIGRATE_TO_V2_PROMPT,
  },
];

export function applicableUpgrades(ctx: ProjectUpgradeContext): readonly ProjectUpgrade[] {
  return PROJECT_UPGRADES.filter((u) => u.applicable(ctx));
}

/**
 * Wrap a freeform "just do this one thing to the project" request in the
 * landing contract every upgrade session must follow. The wrapper is what
 * makes a one-off prompt safe to fire-and-review: whatever the request says,
 * the session still validates, pushes, opens a CR, verifies it's non-empty,
 * and never merges.
 */
export function buildOneOffUpgradePrompt(request: string): string {
  return `Run a one-off, self-contained upgrade of this project. The goal:

${request.trim()}

Ground rules — these override nothing above, they define how the change LANDS:

1. Read the relevant files before writing anything; keep the change as small as the goal allows.
2. Work on your session branch only.
3. If you touched the manifest (kortix.yaml / kortix.toml), run \`kortix validate\` and fix every error before landing.
4. Land it exactly per the kortix-system mandate: \`git fetch origin\` (rebase onto origin/main if it advanced) → commit → \`git push origin HEAD\` → \`kortix cr open --title "<short imperative summary>" --description "<what changed and why>"\` → verify with \`kortix cr diff <n>\` that the CR actually carries your diff. If the push is rejected because the remote session branch moved, fetch and \`git push --force-with-lease origin HEAD\` (your own session branch only).
5. Do NOT run \`kortix cr merge\` — stop once the CR is open and verified non-empty, and tell the user its number.
6. If the goal is already satisfied and there is nothing to change, say so and stop — do not open an empty change request.`;
}
