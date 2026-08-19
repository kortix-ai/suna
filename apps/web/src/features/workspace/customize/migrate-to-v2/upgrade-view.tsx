'use client';

/**
 * The "Upgrades" settings pane — one-off, agent-run project upgrades. Two
 * halves:
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
 *
 * **Layout: the settings pane shape**, the same as `profile-tab.tsx`,
 * `general-tab.tsx`, and `organization-tab.tsx`. Pane heading, then rows —
 * label left, control right, consecutive rows sharing ONE bordered box
 * separated by hairlines (`SettingsRowGroup` / `SettingsRow`,
 * `components/ui/settings-row.tsx`). Sections are a plain small heading
 * (`SettingsSubsectionHeader`).
 *
 * This pane was the odd one out. Six things changed, and each replaced
 * something that was there before:
 *
 * - **It reads its own heading from the rail now.** It used to render
 *   `CustomizeSectionWrapper` with a hardcoded title and description, so the
 *   pane's copy lived in three places at once — here, `rail.ts`'s
 *   `UPGRADE_ITEM.description` (which never rendered), and a third wording in
 *   a `<p>` inside the one-off panel. `SettingsTabHeader tab="upgrades"` makes
 *   the rail entry the single source, exactly like every other pane.
 *   `git-view.tsx` — also a `customize/` view the settings panel mounts — took
 *   this shape first; `tab-content-width.test.ts` tracks both as sections that
 *   declare the panel column themselves. Dropping the wrapper also drops a
 *   nested scroll container: `settings-panel.tsx:524` already gives every pane
 *   `overflow-y-auto`, and the wrapper added a second one inside it.
 * - **The upgrade row is a row, not a glowing card.** It carried
 *   `border-kortix-base/30 bg-kortix-base/[0.06] shadow-kortix-base/20
 *   shadow-md` plus a `ring-1 ring-inset` icon tile. The design system is
 *   explicit that in-flow surfaces get a border and no shadow — elevation
 *   belongs to overlays — and that `kortix-*` accents carry state, not
 *   emphasis. A brand-tinted, shadowed panel in a settings pane is the one
 *   surface here that shouted.
 * - **The "Recommended" badge is gone.** `ProjectUpgrade` has no field that
 *   could ever make it false, so it rendered on every row unconditionally. A
 *   badge that never varies is decoration, and it competed with the Run button
 *   for the same job.
 * - **No dashed empty-state box.** "You're up to date" is one fact; it is a
 *   row in the same group the upgrades would occupy, with the state as a
 *   `Badge`. `EmptyState` is `rounded-lg` and `p-6 md:p-12` — a centred box of
 *   a different shape and radius from everything else in the pane.
 * - **Section headings are headings.** `<Label>` renders a bare `<label>`, so
 *   the pane's outline went `h2` → nothing → rows. `SettingsSubsectionHeader`
 *   is the `h3` level that belongs between them (see that file's header).
 * - **Read-only is one line, not an empty box.** With `canWrite` false the
 *   one-off section used to render a bordered panel holding a sentence and no
 *   control. The section is omitted instead — it is nothing but a composer —
 *   and the reason moves to the first section's description, said once.
 *
 * `UpgradesViewContent` is presentational — no data fetching, so every state
 * renders under `renderToStaticMarkup`. Local textarea and in-flight-row state
 * is fine; the network side lives in the `UpgradesView` wrapper below.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { SettingsTabHeader } from '@/features/workspace/settings/settings-tab-header';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useState } from 'react';

import type { ManifestVersion } from './manifest-version';
import { useProjectManifestVersion } from './manifest-version';
import { type ProjectUpgrade, applicableUpgrades, buildOneOffUpgradePrompt } from './upgrade-defs';
import { useRunUpgrade } from './use-run-upgrade';

/** The one-off runner's id in `startedId` below — it shares the single
 *  `pending` flag with every registry row, so it needs a name in the same
 *  space. Not a `ProjectUpgrade.id`, and it cannot collide with one: registry
 *  ids come from `PROJECT_UPGRADES`, which has no entry by this name. */
const ONE_OFF_ID = 'one-off';

export function UpgradesViewContent({
  version,
  onRun,
  pending,
  canWrite = false,
}: {
  /** `null` = the manifest read hasn't resolved yet. */
  version: ManifestVersion | null;
  onRun: (prompt: string) => void;
  pending: boolean;
  /** When false, the Run actions and the one-off composer are hidden and the
   *  first section says why. The upgrade list itself stays visible — knowing
   *  what is pending is a read, not a write. */
  canWrite?: boolean;
}) {
  const [oneOff, setOneOff] = useState('');
  // Which control the user actually pressed. `pending` is global — only one
  // session can be minted at a time — so without this every Run button on the
  // pane spins at once the moment any one of them is clicked. Latent today
  // (the registry holds one entry) and wrong the day it holds two.
  const [startedId, setStartedId] = useState<string | null>(null);
  const upgrades = version === null ? null : applicableUpgrades({ manifestVersion: version });

  function run(id: string, prompt: string) {
    setStartedId(id);
    onRun(prompt);
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="upgrades" />

      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Available upgrades"
          // Only said when it is true — an explanation of a control you can
          // see is noise; an explanation of a control that is missing is not.
          description={
            canWrite
              ? undefined
              : 'Read-only — running an upgrade needs write access to this workspace.'
          }
        />
        {upgrades === null ? (
          // Shape-matched to one grouped row (px-4 py-3 around a title and a
          // wrapped description), not to the two 64px cards this used to show
          // for a registry that has one entry.
          <Skeleton className="h-[76px] w-full rounded-md" />
        ) : (
          <SettingsRowGroup>
            {upgrades.length === 0 ? (
              <SettingsRow
                label="No upgrades available"
                description="This workspace is already up to date."
              >
                <Badge variant="success" size="sm">
                  Up to date
                </Badge>
              </SettingsRow>
            ) : (
              upgrades.map((upgrade: ProjectUpgrade) => (
                <SettingsRow
                  key={upgrade.id}
                  label={upgrade.title}
                  description={upgrade.description}
                >
                  {canWrite ? (
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => run(upgrade.id, upgrade.prompt)}
                    >
                      {pending && startedId === upgrade.id ? (
                        <Loading className="size-3.5 shrink-0" />
                      ) : null}
                      Run
                    </Button>
                  ) : null}
                </SettingsRow>
              ))
            )}
          </SettingsRowGroup>
        )}
      </section>

      {/* Nothing but a composer, so it has nothing to show a reader who cannot
          use it. The first section already said why it is not here. */}
      {canWrite ? (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title="One-off upgrade"
            description="Describe a single change instead. It runs the same way — a session makes it, validates it, and opens a change request."
          />
          <div className="bg-popover space-y-3 rounded-md border px-4 py-5">
            <Textarea
              // The section heading is an `h3`, not a `<label htmlFor>`, so the
              // control carries its own accessible name — same as the rows in
              // `general-tab.tsx` and `organization-tab.tsx`.
              aria-label="One-off upgrade"
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
                onClick={() => run(ONE_OFF_ID, buildOneOffUpgradePrompt(oneOff))}
              >
                {pending && startedId === ONE_OFF_ID ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : null}
                Run upgrade
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function UpgradesView({ projectId }: { projectId: string }) {
  const { version } = useProjectManifestVersion(projectId);
  const run = useRunUpgrade(projectId);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  return (
    <UpgradesViewContent
      version={version}
      onRun={run.start}
      pending={run.pending}
      canWrite={canWrite}
    />
  );
}
