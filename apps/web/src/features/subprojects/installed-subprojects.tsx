'use client';

import {
  ArrowRightIcon,
  CaretRightIcon,
  DotsThreeIcon,
  GitCommitIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { InstalledSubproject } from '@kortix/sdk';
import { useProjectSubprojects } from '@kortix/sdk/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { prepareInstallSessionNavigation } from '../session/install-session-navigation';
import { subprojectReportHref } from './subproject-runs';
import { countLabel, subprojectOwnsLabel } from './subprojects-catalog';
import { subprojectVisual } from './subproject-visual';

/**
 * What the switch says, and what it does next.
 *
 * `enabled` is three-valued — `null` means SOME of the subproject's triggers are on,
 * or it owns none. A two-state switch cannot render "mixed" honestly, so a mixed
 * subproject shows the switch OFF with a label that says how many are on, and
 * flipping it turns the rest on. That is the action a person wants from a
 * half-on subproject; showing it "on" would hide the half that is not.
 */
function activationLabel(subproject: InstalledSubproject): string {
  const { trigger_count: total, enabled_trigger_count: on } = subproject;
  if (total === 0) return 'No triggers to run';
  if (on === 0) return `Off — ${countLabel(total, 'trigger')} ready`;
  if (on === total) return `On — ${countLabel(total, 'trigger')} firing`;
  return `${on} of ${countLabel(total, 'trigger')} on`;
}

/**
 * One installed subproject: what it contributed, whether it is running, and the two
 * things you can do to it.
 *
 * The switch is the one control that matters. A subproject installs with every
 * trigger OFF — that is deliberate, a subproject that starts firing the moment it
 * lands is a subproject nobody trusts — so this switch is what actually starts it
 * working, and it is the first thing the row shows after the name.
 *
 * A subproject that owns NO triggers has nothing to switch. It gets no switch rather
 * than a dead one: a toggle that cannot change anything is worse than an absent
 * toggle, because it implies state that does not exist.
 */
function InstalledSubprojectRow({
  projectId,
  subproject,
  onUninstall,
  busy,
  onToggle,
  toggling,
}: {
  projectId: string;
  subproject: InstalledSubproject;
  onUninstall: (subproject: InstalledSubproject) => void;
  busy: boolean;
  onToggle: (subproject: InstalledSubproject, enabled: boolean) => void;
  toggling: boolean;
}) {
  const { Icon } = subprojectVisual(subproject.slug);
  const owns = Object.entries(subproject.owns).filter(([, list]) => (list ?? []).length > 0);
  // Controlled off the server's derived value, not local state: the API reads it
  // out of the same manifest the activation route commits to, so the switch
  // cannot drift from what is actually firing.
  const checked = subproject.enabled === true;
  const mixed = subproject.enabled === null && subproject.trigger_count > 0;

  return (
    <li className="bg-popover hover:border-foreground/20 flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors duration-150">
      <Icon weight="fill" className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <HoverPrefetchLink
            href={subprojectReportHref(projectId, subproject.slug)}
            className="group/name text-foreground flex min-w-0 items-center gap-1 text-sm font-medium"
          >
            <span className="truncate">{subproject.title}</span>
            <CaretRightIcon
              className="text-muted-foreground size-3 shrink-0 -translate-x-0.5 opacity-0 transition-[opacity,transform] duration-150 group-hover/name:translate-x-0 group-hover/name:opacity-100"
              aria-hidden
            />
          </HoverPrefetchLink>
        </div>
        <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="font-mono">{subproject.repo}</span>
          {subproject.sha ? (
            <span className="inline-flex items-center gap-1">
              <GitCommitIcon className="size-3" aria-hidden />
              <span className="font-mono">{subproject.sha.slice(0, 7)}</span>
            </span>
          ) : null}
          {owns.map(([kind, list]) => (
            // `subprojectOwnsLabel`, not `{length} {kind}`: the `owns` keys are
            // already plural, so printing one raw rendered "1 agents".
            <span key={kind}>{subprojectOwnsLabel(kind, (list ?? []).length)}</span>
          ))}
          {mixed ? (
            // The surprising state, so it is on the row rather than only in the
            // tooltip: a half-on subproject looks identical to an off one otherwise.
            <span className="text-kortix-yellow">
              {subproject.enabled_trigger_count} of {subproject.trigger_count} triggers on
            </span>
          ) : null}
        </p>
      </div>

      {subproject.trigger_count > 0 ? (
        <Hint
          label={
            <span className="text-xs">
              {toggling ? 'Committing to the manifest…' : activationLabel(subproject)}
            </span>
          }
        >
          <span className="flex shrink-0 items-center">
            {toggling ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <Switch
                checked={checked}
                // Mixed reads as off, and the tooltip says how many are on. The
                // `aria-checked="mixed"` a tri-state control would use is not
                // available on a plain switch, so `aria-label` carries it.
                aria-label={`${activationLabel(subproject)} — ${subproject.title}`}
                onCheckedChange={(next) => onToggle(subproject, next)}
              />
            )}
          </span>
        </Hint>
      ) : (
        // No triggers: nothing to switch. A dead toggle is worse than an absent
        // one, because it implies state that does not exist.
        <span className="text-muted-foreground shrink-0 text-xs">No triggers</span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${subproject.title}`}>
            <DotsThreeIcon className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <HoverPrefetchLink href={subprojectReportHref(projectId, subproject.slug)}>
              View runs
            </HoverPrefetchLink>
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onSelect={(event) => {
              // The dropdown would close and unmount the confirm trigger.
              event.preventDefault();
              onUninstall(subproject);
            }}
          >
            <TrashIcon className="size-4" aria-hidden />
            Uninstall
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * What this project has installed, above the store grid.
 *
 * Renders nothing when nothing is installed — the grid below is already the
 * answer to "you have no subprojects", and an empty panel over it would say the same
 * thing twice.
 */
export function InstalledSubprojects({ projectId }: { projectId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading, uninstall, setActivation } = useProjectSubprojects(projectId);
  const [confirming, setConfirming] = useState<InstalledSubproject | null>(null);
  const [togglingSlug, setTogglingSlug] = useState<string | null>(null);

  const subprojects = data?.subprojects ?? [];
  const errors = data?.errors ?? [];
  if (isLoading || (subprojects.length === 0 && errors.length === 0)) return null;

  const runUninstall = async (subproject: InstalledSubproject) => {
    try {
      const result = await uninstall.mutateAsync(subproject.slug);
      setConfirming(null);
      // Uninstall is a SESSION, like install — the agent removes the entries and
      // opens a change request. Navigating there is the only honest ending: the
      // subproject is still installed until that CR merges.
      const href = prepareInstallSessionNavigation(
        queryClient,
        router,
        projectId,
        result.session_id,
      );
      if (href) router.push(href);
    } catch (error) {
      errorToast(
        error instanceof Error ? error.message : 'Could not start the uninstall session',
      );
    }
  };

  const runToggle = async (subproject: InstalledSubproject, enabled: boolean) => {
    setTogglingSlug(subproject.slug);
    try {
      const result = await setActivation.mutateAsync({ slug: subproject.slug, enabled });
      // An empty trigger list means nothing moved because it was already in this
      // state. Reporting "Enabled" for both would be a lie.
      if (result.triggers.length === 0) {
        successToast(`${subproject.title} was already ${enabled ? 'on' : 'off'}`);
      } else {
        successToast(
          `${enabled ? 'Enabled' : 'Disabled'} ${subproject.title} — ${countLabel(result.triggers.length, 'trigger')}`,
        );
      }
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Could not change this subproject');
    } finally {
      setTogglingSlug(null);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h2 className="text-foreground text-sm font-medium">
          Installed{subprojects.length > 0 ? ` · ${subprojects.length}` : ''}
        </h2>
        {subprojects.length > 0 ? (
          <HoverPrefetchLink
            href={`/projects/${projectId}/subprojects/runs`}
            className="group text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors duration-150"
          >
            View all runs
            <ArrowRightIcon
              className="size-3 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden
            />
          </HoverPrefetchLink>
        ) : null}
      </div>

      {/* A subproject in the manifest that could not be READ. Surfaced, not hidden:
          this is exactly the state a silent list turns into "my subproject vanished". */}
      {errors.length > 0 ? (
        <InfoBanner tone="warning" title="Some subprojects could not be read">
          {errors.map((entry) => (
            <span key={entry.slug} className="block">
              <span className="font-mono">{entry.slug}</span>: {entry.error}
            </span>
          ))}
        </InfoBanner>
      ) : null}

      {subprojects.length > 0 ? (
        <ul className="space-y-2">
          {subprojects.map((subproject) => (
            <InstalledSubprojectRow
              key={subproject.slug}
              projectId={projectId}
              subproject={subproject}
              busy={uninstall.isPending}
              onUninstall={setConfirming}
              onToggle={runToggle}
              toggling={togglingSlug === subproject.slug}
            />
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        title={`Uninstall ${confirming?.title ?? ''}?`}
        description={
          <>
            This starts a session where the agent removes what this subproject contributed and opens a
            change request. Nothing is removed until you merge it.
            {(confirming?.owns.connectors?.length ?? 0) > 0 ? (
              <span className="mt-2 block">
                Its connectors may hold credentials. The agent removes the manifest entries only —
                it never revokes a connection.
              </span>
            ) : null}
          </>
        }
        confirmLabel="Start uninstall"
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-4" aria-hidden />}
        isPending={uninstall.isPending}
        onConfirm={() => {
          if (confirming) void runUninstall(confirming);
        }}
      />
    </section>
  );
}
