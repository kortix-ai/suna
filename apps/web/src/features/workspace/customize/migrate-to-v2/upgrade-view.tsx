'use client';

/**
 * The "Upgrades" customize section — one-off, agent-run project upgrades.
 * Two halves:
 *
 *  1. The registry (`upgrade-defs.ts`): known upgrades with a detection rule
 *     (today: the v1→v2 manifest migration). Rows appear only while
 *     applicable and disappear for good once done.
 *  2. A freeform one-off runner: describe a single change ("bump X",
 *     "restructure Y") and a session makes it and opens a change request —
 *     the same mechanics, minus the registry entry.
 *
 * Every run is a session, not a form: the only way config lands is through
 * an agent editing the repo on a branch and opening a CR the user reviews.
 * Nothing here merges anything.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ArrowUpCircle, CircleCheckBig } from 'lucide-react';
import { useState } from 'react';

import CustomizeSectionWrapper from '../sections/component/section-wrapper';
import type { ManifestVersion } from './manifest-version';
import { useProjectManifestVersion } from './manifest-version';
import { type ProjectUpgrade, applicableUpgrades, buildOneOffUpgradePrompt } from './upgrade-defs';
import { useRunUpgrade } from './use-run-upgrade';

/** Presentational only — no data fetching, so every state renders under
 *  renderToStaticMarkup. Local textarea state is fine; the network side
 *  lives in the `UpgradesView` wrapper below. */
export function UpgradesViewContent({
  version,
  onRun,
  pending,
}: {
  /** `null` = the manifest read hasn't resolved yet. */
  version: ManifestVersion | null;
  onRun: (prompt: string) => void;
  pending: boolean;
}) {
  const [oneOff, setOneOff] = useState('');
  const upgrades = version === null ? null : applicableUpgrades({ manifestVersion: version });

  return (
    <CustomizeSectionWrapper
      title="Upgrades"
      description="One-off, agent-run changes — each run starts a session that makes the change and opens a change request for you to review."
    >
      <section className="space-y-4">
        <Label>Available upgrades</Label>
        {upgrades === null ? (
          <div className="space-y-2">
            {['a', 'b'].map((k) => (
              <Skeleton key={k} className="h-16 w-full rounded-md" />
            ))}
          </div>
        ) : upgrades.length === 0 ? (
          <EmptyState
            icon={CircleCheckBig}
            size="sm"
            title="You're up to date"
            description="No pending platform upgrades for this project."
          />
        ) : (
          <ul className="space-y-2">
            {upgrades.map((upgrade: ProjectUpgrade) => (
              <li
                key={upgrade.id}
                className="border-kortix-base/30 bg-kortix-base/[0.06] shadow-kortix-base/20 flex items-center gap-3 rounded-md border px-4 py-3 shadow-md transition-colors hover:border-kortix-base/45 hover:bg-kortix-base/[0.09]"
              >
                <span className="bg-kortix-base/15 ring-kortix-base/25 flex size-9 shrink-0 items-center justify-center rounded-sm ring-1 ring-inset">
                  <ArrowUpCircle className="text-kortix-base size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-foreground text-sm font-medium text-balance">
                      {upgrade.title}
                    </p>
                    <Badge variant="kortix" size="xs" className="shrink-0">
                      Recommended
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                    {upgrade.description}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0"
                  disabled={pending}
                  onClick={() => onRun(upgrade.prompt)}
                >
                  {pending ? <Loading className="size-3.5 shrink-0" /> : null}
                  Run
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <Label>One-off upgrade</Label>
        <div className="bg-popover space-y-3 rounded-md border px-4 py-5">
          <p className="text-muted-foreground text-xs text-pretty">
            Describe a single change to this project. An agent session makes it, validates, and
            opens a change request — it never merges on its own.
          </p>
          <Textarea
            value={oneOff}
            onChange={(event) => setOneOff(event.target.value)}
            placeholder="e.g. Rename the release-bot agent to deploy-bot everywhere it's referenced"
            minHeight={72}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || !oneOff.trim()}
              onClick={() => onRun(buildOneOffUpgradePrompt(oneOff))}
            >
              {pending ? <Loading className="size-3.5 shrink-0" /> : null}
              Run upgrade
            </Button>
          </div>
        </div>
      </section>
    </CustomizeSectionWrapper>
  );
}

export function UpgradesView({ projectId }: { projectId: string }) {
  const { version } = useProjectManifestVersion(projectId);
  const run = useRunUpgrade(projectId);
  return <UpgradesViewContent version={version} onRun={run.start} pending={run.pending} />;
}
