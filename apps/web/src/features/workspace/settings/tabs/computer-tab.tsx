'use client';

/**
 * Settings › My computer: the page form of `ComputerConnectModal` (KRTX-1997).
 * It lists the computers this person paired; a row opens that computer's
 * controls (`ComputerDetailsModal`).
 *
 * Every way to pair, from the same hooks the modal uses:
 * 1. The desktop app, this machine unpaired → one click.
 * 2. Another computer → install the desktop app there.
 * 3. Anywhere → copy the CLI pairing command.
 *
 * Project-scoped only because the CLI command and the desktop pairing name
 * the project they start from; the paired machine follows its owner into every
 * project.
 */

import { CaretRightIcon, MonitorIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { SettingsSubsectionHeader } from '@kortix/ui/settings-subsection-header';
import { Download } from '@kortix/ui/internal/icons/download';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import {
  ComputerCapabilities,
  ComputerGlyph,
  ComputerStateDot,
  computerDisplayName,
  platformName,
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useThisComputerState,
} from '@kortix/ui/internal/tunnel/computer-connect';
import { ComputerDetailsModal } from '@/features/tunnel/local-computer-modal';
import { buildTunnelConnectCommand } from '@kortix/ui/internal/tunnel/tunnel-connect-command';
import { useCopy } from '@kortix/ui/internal/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl, isDesktop, startDownload } from '@kortix/ui/internal/lib/desktop';
import { getEnv } from '@/lib/env-config';

import { SettingsTabHeader } from '@kortix/ui/customize/settings/settings-tab-header';

export function ComputerTab({ projectId }: { projectId: string }) {
  const t = useTranslations('computers');
  const tPage = useTranslations('settings.computer');
  const paired = useOwnsPairedComputer();
  const { desktop, oneClick, stale, tunnelId } = useThisComputerState();
  const connectDesktop = useConnectDesktopComputer(projectId);
  // The button itself confirms the copy; no toast.
  const { copied, copy } = useCopy({ toast: false });
  const [openTunnelId, setOpenTunnelId] = useState<string | null>(null);

  // The desktop app connects the machine it runs on in one click. Elsewhere,
  // and for any other computer, the way in is the desktop app on that machine.
  const showDownload = (desktop.isSuccess && !desktop.data && !isDesktop()) || paired.owns;
  const copyCliCommand = () =>
    copy(
      buildTunnelConnectCommand({
        backendUrl: getEnv().BACKEND_URL || '',
        origin: window.location.origin,
        projectId,
      }),
    );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="computer" />

      {paired.owned.length > 0 ? (
        <section className="space-y-3">
          <SettingsSubsectionHeader title={t('yourComputersTitle')} />
          <SettingsRowGroup>
            {paired.owned.map((machine) => {
              const platform = platformName(machine.machineInfo?.platform);
              return (
                <button
                  key={machine.tunnelId}
                  type="button"
                  onClick={() => setOpenTunnelId(machine.tunnelId)}
                  className="hover:bg-hover flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
                >
                  <ComputerGlyph />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm font-medium">
                      {computerDisplayName(machine.name, machine.machineInfo) || machine.name}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {[machine.tunnelId === tunnelId ? t('thisComputerBadge') : null, platform]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                    <ComputerStateDot state={machine.isLive ? 'online' : 'offline'} />
                    {machine.isLive ? t('online') : t('offline')}
                  </span>
                  <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              );
            })}
          </SettingsRowGroup>
        </section>
      ) : null}

      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={paired.owns ? t('connectAnother') : t('connectYourComputer')}
        />
        <SettingsRowGroup>
          {oneClick ? (
            <SettingsRow label={t('thisComputer')} description={tPage('oneClickDescription')}>
              <Button
                type="button"
                size="sm"
                className="gap-1.5"
                disabled={connectDesktop.isPending}
                onClick={() => connectDesktop.mutate({ reauth: stale })}
              >
                {connectDesktop.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <MonitorIcon className="size-3.5 shrink-0" />
                )}
                {connectDesktop.isPending ? t('connecting') : t('connectThisComputer')}
              </Button>
            </SettingsRow>
          ) : null}
          {showDownload ? (
            <SettingsRow
              label={tPage('desktopLabel')}
              description={paired.owns ? tPage('otherComputerHint') : t('downloadHint')}
            >
              <Button
                type="button"
                size="sm"
                className="gap-1.5"
                onClick={() => startDownload(desktopDownloadUrl())}
              >
                <Download className="size-3.5 shrink-0" />
                {tPage('download')}
              </Button>
            </SettingsRow>
          ) : null}
          <SettingsRow label={tPage('cliLabel')} description={t('cliHint')}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={copyCliCommand}
            >
              {copied ? (
                <SolidCheckIcon className="size-3.5" />
              ) : (
                <TerminalWindowIcon className="size-3.5 shrink-0" />
              )}
              {copied ? t('commandCopied') : t('copyCommand')}
            </Button>
          </SettingsRow>
        </SettingsRowGroup>
      </section>

      {/* Before the first pairing, what a computer gives Kortix. After it, each
          computer's own controls hold the same list as switches. */}
      {paired.owns ? null : (
        <section className="space-y-3">
          <SettingsSubsectionHeader title={t('capabilitiesTitle')} />
          <SettingsRowGroup className="px-4 py-0">
            <ComputerCapabilities />
          </SettingsRowGroup>
        </section>
      )}

      <ComputerDetailsModal
        projectId={projectId}
        tunnelId={openTunnelId}
        onOpenChange={(open) => {
          if (!open) setOpenTunnelId(null);
        }}
      />    </div>
  );
}
