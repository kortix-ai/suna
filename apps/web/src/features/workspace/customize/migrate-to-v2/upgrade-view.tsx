'use client';

/**
 * The "Upgrade to v2" customize section — the dedicated home of the agent-led
 * kortix.toml → kortix.yaml migration. The rail only shows this section while
 * the project is still on a v1 manifest, but the section itself handles every
 * state (loading / already-v2 via deep-link / v1) so a stale link never
 * renders a broken page.
 *
 * The action is deliberately a session, not a form: the only way config lands
 * is through an agent editing the repo on a branch and opening a change
 * request, so the button seeds a session with MIGRATE_TO_V2_PROMPT and drops
 * the user into the thread.
 */

import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { CircleCheckBig } from 'lucide-react';
import type { ReactNode } from 'react';

import CustomizeSectionWrapper from '../sections/component/section-wrapper';
import type { ManifestVersion } from './manifest-version';
import { useProjectManifestVersion } from './manifest-version';
import { MigrateToV2Button } from './migrate-to-v2-button';

const STEPS: readonly { title: string; body: string }[] = [
  {
    title: 'An agent session does the conversion',
    body: 'Your project’s default agent reads the current kortix.toml, translates the [[agents]] array into the v2 agents: map, and writes kortix.yaml against the canonical schema.',
  },
  {
    title: 'Nothing narrows silently',
    body: 'v2 is deny-by-default, so every grant an agent has today (connectors, secrets, CLI actions, skills) is written out explicitly — access stays exactly as it is.',
  },
  {
    title: 'You review and merge',
    body: 'The agent validates the result, commits on its branch, and opens a change request. Nothing changes on main until you approve the diff.',
  },
];

/** Presentational only — no hooks, no data fetching. Kept separate from
 *  `UpgradeView` so every state (loading / v1 / already-v2) is testable
 *  without mocking react-query or the SDK. */
export function UpgradeViewContent({
  version,
  action,
}: {
  /** `null` = the manifest read hasn't resolved yet. */
  version: ManifestVersion | null;
  action?: ReactNode;
}) {
  return (
    <CustomizeSectionWrapper
      title="Upgrade to v2"
      description="Move this project from the v1 kortix.toml manifest to kortix.yaml (v2)."
      action={version === 1 ? action : undefined}
    >
      {version === null ? (
        <div className="space-y-2">
          {['a', 'b', 'c'].map((k) => (
            <Skeleton key={k} className="h-16 w-full rounded-md" />
          ))}
        </div>
      ) : version === 2 ? (
        <EmptyState
          icon={CircleCheckBig}
          size="sm"
          title="Already on v2"
          description="This project uses the kortix.yaml (v2) manifest — there is nothing to migrate."
        />
      ) : (
        <section className="space-y-4">
          <Label>What happens</Label>
          <ul className="space-y-2">
            {STEPS.map((step, i) => (
              <li
                key={step.title}
                className="bg-popover flex items-start gap-3 rounded-md border px-4 py-3"
              >
                <span className="bg-kortix-base/15 text-kortix-base flex size-9 shrink-0 items-center justify-center rounded-sm text-sm font-medium tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">{step.title}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{step.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs text-pretty">
            v2 unifies per-agent governance in one place — explicit connector, secret, CLI, and
            skill grants per agent, a required default agent, and YAML with schema-backed editor
            support. Agent behavior files (
            <span className="font-mono">.kortix/opencode/agents/*.md</span>) are left untouched.
          </p>
        </section>
      )}
    </CustomizeSectionWrapper>
  );
}

export function UpgradeView({ projectId }: { projectId: string }) {
  const { version } = useProjectManifestVersion(projectId);
  return (
    <UpgradeViewContent version={version} action={<MigrateToV2Button projectId={projectId} />} />
  );
}
