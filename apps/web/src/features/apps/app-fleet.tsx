'use client';

/**
 * The machines and volumes of an App, in the App detail's
 * bottom panel next to its releases. A machine runs one process group of the
 * live release; a volume outlives every release. Clients branch on
 * capabilities: `machines`, `scale`, `volumes`, `snapshots`.
 */
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';

import { useTranslations } from '@/i18n/use-translations';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

import { type App, type AppMachine, type AppVolume } from '@kortix/sdk';
import { useAppMachines, useAppVolumeSnapshots, useAppVolumes } from '@kortix/sdk/react';
import { CameraIcon, CopyIcon } from '@phosphor-icons/react';

import { useState } from 'react';

import { appCan } from './app-shared';

/** How long a machine has been up: "3h 12m", "12m", "2d 4h". */
export function uptime(since: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** The stepper's glyphs, 16px, drawn in the text color. */
const GLYPH = {
  minus: <path d="M4 8h8" />,
  plus: <path d="M4 8h8M8 4v8" />,
};

function Glyph({ name }: { name: keyof typeof GLYPH }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4 shrink-0 fill-none stroke-current stroke-[1.5] [stroke-linecap:round] [stroke-linejoin:round]"
    >
      {GLYPH[name]}
    </svg>
  );
}

/**
 * The machines of each process group. Built from the Paper pick "M01 · Process
 * group card": the group is the card, its size and its machine count sit in
 * the card's header where they apply to every machine at once, and each
 * machine is one row with one labeled action.
 */
export function AppMachinesPanel({ projectId, app, canDeploy }: { projectId: string; app: App; canDeploy: boolean }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const machines = useAppMachines(projectId, app.app_id);
  if (machines.isLoading) return <Loading className="text-muted-foreground" />;
  const rows = machines.data ?? [];
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text20ddf75b6570')}</p>;
  }
  const groups = [...new Set(rows.map((machine) => machine.process_group))];
  const scaleOf = (group: string) => app.scale?.[group] ?? rows.filter((machine) => machine.process_group === group).length;
  const canScale = canDeploy && appCan(app, 'scale');
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        const members = rows.filter((machine) => machine.process_group === group);
        const vm = members[0]!.vm;
        return (
          <div key={group} className="flex flex-col">
            {/* Same two sections as the Releases tab ("Live now", "History"):
                a labeled card for the group, then a labeled list of its
                machines, with the same spacing between them. */}
            <section className="flex flex-col gap-2">
              <h3 className="text-muted-foreground/70 text-xs font-medium">{tI18nComplete.raw('textb1a7e40c2d19')}</h3>
              <div className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-foreground truncate font-mono text-sm font-medium">{group}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground/70 text-xs">{tI18nComplete.raw('textc061da196eae')}</span>
                    {canScale ? (
                      <MachineCount
                        count={scaleOf(group)}
                        pending={machines.scale.isPending}
                        onScale={(next) => machines.scale.mutate({ [group]: next })}
                      />
                    ) : (
                      <span className="text-foreground font-mono text-sm tabular-nums">{scaleOf(group)}</span>
                    )}
                  </span>
                </div>
                <dl className="flex gap-6">
                  {[
                    { label: tI18nComplete.raw('textb1a7e40c2d1c'), value: `${vm.cpu} vCPU` },
                    { label: tI18nComplete.raw('textc3963aedaac6'), value: `${vm.memory_gb} GB` },
                    { label: tI18nComplete.raw('textb1a7e40c2d1d'), value: `${vm.disk_gb} GB` },
                  ].map((fact) => (
                    <div key={fact.label} className="flex flex-col gap-0.5">
                      <dt className="text-muted-foreground/70 text-xs">{fact.label}</dt>
                      <dd className="text-foreground text-sm">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </section>
            <section className="flex flex-col gap-1 pt-6">
              <h3 className="text-muted-foreground/70 pb-1 text-xs font-medium">{tI18nComplete.raw('textc061da196eae')}</h3>
              <ul className="-mx-2 flex flex-col gap-1">
                {members.map((machine) => (
                  <MachineRow key={machine.instance_id} machine={machine} canDeploy={canDeploy} machines={machines} />
                ))}
              </ul>
            </section>
          </div>
        );
      })}
    </div>
  );
}

/** The group's machine count as one bordered stepper: −, the count, +. */
function MachineCount({ count, pending, onScale }: { count: number; pending: boolean; onScale: (next: number) => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const step =
    'text-muted-foreground hover:text-foreground hover:bg-muted/50 flex h-full w-7.5 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="flex h-7.5 items-center overflow-hidden rounded-md border">
      <button
        type="button"
        className={step}
        disabled={pending || count <= 0}
        onClick={() => onScale(count - 1)}
        aria-label={tI18nComplete.raw('text8265774743cb')}
      >
        <Glyph name="minus" />
      </button>
      <span
        aria-live="polite"
        className="text-foreground flex h-full w-7.5 items-center justify-center border-x font-mono text-sm tabular-nums"
      >
        {count}
      </span>
      <button
        type="button"
        className={step}
        disabled={pending || count >= 20}
        onClick={() => onScale(count + 1)}
        aria-label={tI18nComplete.raw('text191338ba2258')}
      >
        <Glyph name="plus" />
      </button>
    </div>
  );
}

function MachineRow({
  machine,
  canDeploy,
  machines,
}: {
  machine: AppMachine;
  canDeploy: boolean;
  machines: ReturnType<typeof useAppMachines>;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const running = machine.state === 'started';
  const stopped = machine.state === 'stopped';
  const busy = machines.start.isPending || machines.stop.isPending || machines.restart.isPending;
  const stateLabel = {
    started: tI18nComplete.raw('textf4ccae29e1bb'),
    starting: tI18nComplete.raw('textb1a7e40c2d17'),
    stopping: tI18nComplete.raw('textb1a7e40c2d18'),
    stopped: tI18nComplete.raw('text1a4f630ac1b6'),
    provisioning: tI18nComplete.raw('textc2b1b8e2e039'),
  }[machine.state];
  const detail = [`v${machine.release.version}`, machine.volume?.name ?? null].filter(Boolean).join(' · ');
  // Up for how long, or stopped since when: the release row's age lane.
  const since = running && machine.started_at
    ? tI18nComplete('textb1a7e40c2d1b', { value0: uptime(machine.started_at) })
    : stopped && machine.stopped_at
      ? relativeTime(machine.stopped_at)
      : null;

  // Same lanes as a release row: id (w-20), state and version on one line,
  // time (w-15), one action (w-20).
  return (
    <li className="hover:bg-muted/50 flex h-11 items-center gap-3 rounded-md px-2">
      <span className="text-foreground w-20 shrink-0 font-mono text-sm font-medium">{machine.machine_id.slice(0, 8)}</span>
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className={running ? 'text-kortix-green' : 'text-foreground'}>{stateLabel}</span>
        <span className="text-muted-foreground/70"> · {detail}</span>
      </span>
      <span className="text-muted-foreground/70 w-15 shrink-0 text-right text-xs tabular-nums">{since}</span>
      <span className="flex w-20 shrink-0 justify-end">
        {canDeploy && running ? (
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => machines.restart.mutate(machine.machine_id)}
          >
            {tI18nComplete.raw('text6b983a81e5e8')}
          </Button>
        ) : canDeploy && stopped ? (
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => machines.start.mutate(machine.machine_id)}>
            {tI18nComplete.raw('texte4bb9f1ece9a')}
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/** One row per volume: size, attached or not, and its snapshots (restore, fork). */
export function AppVolumesPanel({ projectId, app, canDeploy, canAdmin }: { projectId: string; app: App; canDeploy: boolean; canAdmin: boolean }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const volumes = useAppVolumes(projectId, app.app_id);
  const [openId, setOpenId] = useState<string | null>(null);
  if (volumes.isLoading) return <Loading className="text-muted-foreground" />;
  const rows = volumes.data ?? [];
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textd87f1756f060')}</p>;
  }
  return (
    <div className="space-y-1">
      {rows.map((volume) => (
        <div key={volume.volume_id}>
          <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5">
            <button
              type="button"
              className="text-foreground w-32 shrink-0 cursor-pointer truncate text-left font-mono text-xs"
              onClick={() => setOpenId((current) => (current === volume.volume_id ? null : volume.volume_id))}
            >
              {volume.name}
            </button>
            <Badge variant={volume.attached ? 'default' : 'outline'} size="sm">
              {volume.attached ? tI18nComplete.raw('textac6d9b76a141') : tI18nComplete.raw('text8d54763edcd8')}
            </Badge>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {[`${volume.size_gb} GB`, volume.process_group, tI18nComplete('textffeb0c99532f', { value0: volume.snapshot_retention_days })].join(' · ')}
            </span>
            {canDeploy ? (
              <Hint label={tI18nComplete.raw('text6f52b07880a0')}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={volumes.snapshot.isPending}
                  onClick={async () => {
                    try {
                      await volumes.snapshot.mutateAsync(volume.volume_id);
                      successToast(tI18nComplete.raw('text9a2de8b2728e'));
                    } catch {
                      // Failure is already toasted by the query client's global mutations.onError.
                    }
                  }}
                  aria-label={tI18nComplete.raw('text6f52b07880a0')}
                >
                  <CameraIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
            ) : null}
          </div>
          {openId === volume.volume_id ? (
            <VolumeSnapshots projectId={projectId} app={app} volume={volume} volumes={volumes} canDeploy={canDeploy} canAdmin={canAdmin} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function VolumeSnapshots({
  projectId,
  app,
  volume,
  volumes,
  canDeploy,
  canAdmin,
}: {
  projectId: string;
  app: App;
  volume: AppVolume;
  volumes: ReturnType<typeof useAppVolumes>;
  canDeploy: boolean;
  canAdmin: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const snapshots = useAppVolumeSnapshots(projectId, app.app_id, volume.volume_id);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [forkName, setForkName] = useState(`${volume.name}_copy`.slice(0, 30));
  return (
    <div className="space-y-2 py-1 pr-2 pl-8">
      {snapshots.isLoading ? (
        <Loading className="text-muted-foreground" />
      ) : snapshots.data?.length ? (
        snapshots.data.map((snapshot) => (
          <div key={snapshot.snapshot_id} className="flex items-center gap-3">
            <span className="text-foreground w-48 shrink-0 truncate font-mono text-xs">{snapshot.snapshot_id}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{snapshot.kind}</span>
            {canAdmin ? (
              <Button variant="ghost" size="xs" onClick={() => setRestoreId(snapshot.snapshot_id)}>
                {tI18nComplete.raw('texta76e13b98392')}
              </Button>
            ) : null}
          </div>
        ))
      ) : (
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textdf80631943fa')}</p>
      )}
      {canDeploy ? (
        <div className="flex items-center gap-2 pt-1">
          <Input
            value={forkName}
            onChange={(event) => setForkName(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30))}
            aria-label={tI18nComplete.raw('textda50c072e245')}
            className="h-7 w-48 font-mono text-xs"
          />
          <Button
            variant="outline"
            size="xs"
            disabled={volumes.fork.isPending || !forkName}
            onClick={async () => {
              try {
                const copy = await volumes.fork.mutateAsync({ volumeId: volume.volume_id, name: forkName });
                successToast(tI18nComplete('text410a0b58bcbf', { value0: copy.name }));
              } catch {
                // Failure is already toasted by the query client's global mutations.onError.
              }
            }}
          >
            <CopyIcon className="size-3.5 shrink-0" />
            {tI18nComplete.raw('text8e5b1a73152c')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={restoreId !== null}
        onOpenChange={(next) => !next && setRestoreId(null)}
        title={tI18nComplete.raw('text03b08ce05c4f')}
        description={tI18nComplete('text3026d54f70df', { value0: volume.name })}
        confirmLabel={tI18nComplete.raw('texta76e13b98392')}
        isPending={volumes.restore.isPending}
        onConfirm={async () => {
          if (!restoreId) return;
          try {
            await volumes.restore.mutateAsync({ volumeId: volume.volume_id, snapshotId: restoreId });
            setRestoreId(null);
            successToast(tI18nComplete('texte37a10b4757e', { value0: volume.name }));
          } catch {
            // Failure is already toasted by the query client's global mutations.onError.
          }
        }}
      />
    </div>
  );
}

