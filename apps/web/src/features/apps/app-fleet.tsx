'use client';

/**
 * The machines and volumes of an App (the Fly.io model), in the App detail's
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

import { type App, type AppMachine, type AppVolume } from '@kortix/sdk';
import { useAppMachines, useAppVolumeSnapshots, useAppVolumes } from '@kortix/sdk/react';
import { ArrowCounterClockwiseIcon, CameraIcon, CopyIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon } from '@phosphor-icons/react';

import { useState } from 'react';

import { appCan } from './app-shared';

const STATE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  started: 'default',
  starting: 'secondary',
  stopping: 'secondary',
  stopped: 'outline',
};

/** One row per machine, grouped by process group, with the group's machine count. */
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
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group} className="space-y-1">
          <div className="flex items-center gap-2 px-2">
            <span className="text-foreground font-mono text-xs">{group}</span>
            {canDeploy && appCan(app, 'scale') ? (
              <span className="ml-auto flex items-center gap-1">
                <Hint label={tI18nComplete.raw('text8265774743cb')}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={machines.scale.isPending || scaleOf(group) <= 0}
                    onClick={() => machines.scale.mutate({ [group]: scaleOf(group) - 1 })}
                    aria-label={tI18nComplete.raw('text8265774743cb')}
                  >
                    <MinusIcon className="size-3.5 shrink-0" />
                  </Button>
                </Hint>
                <span className="text-muted-foreground w-6 text-center text-xs tabular-nums">{scaleOf(group)}</span>
                <Hint label={tI18nComplete.raw('text191338ba2258')}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={machines.scale.isPending || scaleOf(group) >= 20}
                    onClick={() => machines.scale.mutate({ [group]: scaleOf(group) + 1 })}
                    aria-label={tI18nComplete.raw('text191338ba2258')}
                  >
                    <PlusIcon className="size-3.5 shrink-0" />
                  </Button>
                </Hint>
              </span>
            ) : null}
          </div>
          {rows.filter((machine) => machine.process_group === group).map((machine) => (
            <MachineRow key={machine.instance_id} machine={machine} canDeploy={canDeploy} machines={machines} />
          ))}
        </div>
      ))}
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
  const busy = machines.start.isPending || machines.stop.isPending || machines.restart.isPending;
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5">
      <span className="text-foreground w-20 shrink-0 font-mono text-xs">{machine.machine_id.slice(0, 8)}</span>
      <Badge variant={STATE_VARIANT[machine.state] ?? 'outline'} size="sm">{machine.state}</Badge>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {[
          `v${machine.release.version}`,
          tI18nComplete('textce0eabb01151', { value0: machine.vm.cpu, value1: machine.vm.memory_gb, value2: machine.vm.disk_gb }),
          machine.volume ? tI18nComplete('text451df0325fb4', { value0: machine.volume.name ?? machine.volume.volume_id.slice(0, 8) }) : null,
        ].filter(Boolean).join(' · ')}
      </span>
      {canDeploy ? (
        <span className="flex shrink-0 items-center gap-1">
          <Hint label={running ? tI18nComplete.raw('textcae7d57bc067') : tI18nComplete.raw('texte4bb9f1ece9a')}>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              onClick={() => (running ? machines.stop : machines.start).mutate(machine.machine_id)}
              aria-label={running ? tI18nComplete.raw('textcae7d57bc067') : tI18nComplete.raw('texte4bb9f1ece9a')}
            >
              {running ? <PauseIcon weight="fill" className="size-3.5 shrink-0" /> : <PlayIcon className="size-3.5 shrink-0" />}
            </Button>
          </Hint>
          <Hint label={tI18nComplete.raw('text6b983a81e5e8')}>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy || !running}
              onClick={() => machines.restart.mutate(machine.machine_id)}
              aria-label={tI18nComplete.raw('text6b983a81e5e8')}
            >
              <ArrowCounterClockwiseIcon className="size-3.5 shrink-0" />
            </Button>
          </Hint>
        </span>
      ) : null}
    </div>
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

/** The App's services and their URLs: one chip each, the access level in its hint. */
export function AppServices({ app }: { app: App }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const services = (app.services ?? []).filter((service) => service.name !== 'http');
  if (services.length === 0) return null;
  const accessLabel = (access: string) =>
    access === 'public' ? tI18nComplete.raw('text591935b15b1c') : access === 'admins' ? tI18nComplete.raw('textce1d48e5a23f') : tI18nComplete.raw('textbfc580646bea');
  return (
    <span className="hidden shrink-0 items-center gap-1 md:flex">
      {services.map((service) => (
        <Hint key={service.name} label={`${accessLabel(service.access)} · :${service.internal_port}`}>
          {service.url ? (
            <a href={service.url} target="_blank" rel="noreferrer">
              <Badge variant="outline" size="sm" className="cursor-pointer font-mono">{service.name}</Badge>
            </a>
          ) : (
            <Badge variant="outline" size="sm" className="font-mono">{service.name}</Badge>
          )}
        </Hint>
      ))}
    </span>
  );
}
