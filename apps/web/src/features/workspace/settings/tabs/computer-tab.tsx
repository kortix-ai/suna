'use client';

/**
 * Settings › Computer: the page form of `ComputerConnectModal` (KRTX-1997).
 * The modal is reachable only from a dismissible sidebar promo; this page
 * always is, and it stays useful after pairing: it lists the computers this
 * person paired.
 *
 * Every way to pair, from the same hooks the modal uses:
 * 1. The desktop app, this machine unpaired → one click.
 * 2. A browser → download the desktop app.
 * 3. Anywhere → copy the CLI pairing command.
 *
 * Project-scoped only because the CLI command and the desktop pairing name
 * the project they start from; the paired machine follows its owner into every
 * project.
 */

import { MonitorIcon, TerminalWindowIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Download } from '@/features/icon/icons/download';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import {
  ComputerCapabilities,
  ComputerGlyph,
  ComputerStateDot,
  computerDisplayName,
  platformName,
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useThisComputerState,
} from '@/features/tunnel/computer-connect';
import { buildTunnelConnectCommand } from '@/features/tunnel/tunnel-connect-command';
import { useCopy } from '@/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl, isDesktop, startDownload } from '@/lib/desktop';
import { getEnv } from '@/lib/env-config';

import { SettingsTabHeader } from '../settings-tab-header';

export function ComputerTab({ projectId }: { projectId: string }) {
  const t = useTranslations('computers');
  const tPage = useTranslations('settings.computer');
  const paired = useOwnsPairedComputer();
  const { desktop, oneClick, stale, tunnelId } = useThisComputerState();
  const connectDesktop = useConnectDesktopComputer(projectId);
  // The button itself confirms the copy; no toast.
  const { copied, copy } = useCopy({ toast: false });

  const inBrowser = desktop.isSuccess && !desktop.data && !isDesktop();
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
                <div key={machine.tunnelId} className="flex items-center gap-3 px-4 py-3">
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
                </div>
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
          {inBrowser ? (
            <SettingsRow label={tPage('desktopLabel')} description={t('downloadHint')}>
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

      <section className="space-y-3">
        <SettingsSubsectionHeader title={t('capabilitiesTitle')} />
        <SettingsRowGroup className="px-4 py-0">
          <ComputerCapabilities />
        </SettingsRowGroup>
      </section>
    </div>
  );
}
