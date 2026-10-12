'use client';

/**
 * "Apps and extensions": every way to use Kortix outside this tab, in one
 * dialog. Chrome first, then the computer, then the developer surfaces. Each
 * row opens the dialog that already owns the flow (computer, MCP, Settings →
 * Kortix in Chrome); nothing here pairs or connects by itself.
 */

import { useBrowsers } from '@kortix/sdk/react';
import {
  ArrowUpRightIcon,
  DownloadSimpleIcon,
  LaptopIcon,
  MonitorIcon,
  PlugsConnectedIcon,
  TerminalWindowIcon,
  type Icon,
} from '@phosphor-icons/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import {
  BrowserOnlineDot,
  ChromeButtonMark,
  useBrowserConnect,
} from '@/features/browser/browser-connect';
import { BrowserLogoTile } from '@/features/browser/browser-icon';
import { BrowserMock } from '@/features/browser/browser-mock';
import { chromeCardState } from '@/features/browser/chrome-card-state';
import { KORTIX_EXTENSION_STORE_URL } from '@/features/browser/extension';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { detectPlatform, isMobilePlatform } from '@/features/marketing/download/detect-os';
import { useOwnsPairedComputer } from '@/features/tunnel/computer-connect';
import { useCopy } from '@/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl, isDesktop } from '@/lib/desktop';
import { getEnv } from '@/lib/env-config';
import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { useAppsModalStore } from '@/stores/apps-modal-store';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

/** Opens the dialog from `?apps=1` and removes the parameter. */
export function useAppsDeepLink() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const wanted = params.get('apps') === '1';
  useEffect(() => {
    if (!wanted) return;
    useAppsModalStore.getState().setOpen(true);
    const next = new URLSearchParams(params.toString());
    next.delete('apps');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [wanted, params, pathname, router]);
}

export function AppsModal({
  onOpenComputer,
  onOpenMcp,
}: {
  onOpenComputer: () => void;
  onOpenMcp: () => void;
}) {
  const t = useTranslations('appsModal');
  const open = useAppsModalStore((state) => state.open);
  const setOpen = useAppsModalStore((state) => state.setOpen);
  useAppsDeepLink();
  // Close first, then hand over: one dialog on screen at a time.
  const hand = (next: () => void) => () => {
    setOpen(false);
    next();
  };

  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalContent className="max-h-[90dvh] space-y-0 overflow-y-auto lg:max-w-2xl">
        <div className="flex flex-col gap-5 p-5 lg:p-8">
          <header className="space-y-1.5 pr-10">
            <ModalTitle className="text-xl font-medium text-balance">{t('title')}</ModalTitle>
            <ModalDescription className="sr-only">{t('name')}</ModalDescription>
          </header>
          {open ? (
            <>
              <ChromeCard onManage={() => setOpen(false)} />
              <div className="grid gap-5 sm:grid-cols-2">
                <ComputerCard onOpenComputer={hand(onOpenComputer)} />
                <DevelopersCard onOpenMcp={hand(onOpenMcp)} />
              </div>
            </>
          ) : null}
        </div>
      </ModalContent>
    </Modal>
  );
}

function ChromeCard({ onManage }: { onManage: () => void }) {
  const t = useTranslations('appsModal.chrome');
  const { environment, checking, installed, signedIn, connected, connect } = useBrowserConnect();
  const browsers = useBrowsers();
  const browser = connected ?? browsers.data?.find((item) => item.online) ?? browsers.data?.[0];
  const state = chromeCardState({
    hasConnectedBrowser: Boolean(browser),
    environment,
    checking,
    installed: installed || signedIn,
  });

  return (
    <section className="bg-popover grid overflow-hidden rounded-md border sm:grid-cols-2">
      <div className="flex flex-col gap-4 p-5">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <BrowserLogoTile brand="chrome" className="size-7" iconClassName="size-4" />
            <h3 className="text-sm font-medium">{t('name')}</h3>
          </div>
          <p className="text-muted-foreground text-sm text-pretty">{t('description')}</p>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          {state === 'connected' && browser ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onManage();
                  useSettingsPanelStore.getState().openSettings('browsers');
                }}
              >
                {t('manage')}
              </Button>
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <BrowserOnlineDot online={browser.online} />
                <span className="truncate">{browser.name}</span>
              </span>
            </>
          ) : state === 'unsupported' ? (
            <p className="text-muted-foreground text-xs text-pretty">{t('unsupported')}</p>
          ) : state === 'installed' ? (
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {connect.isPending ? t('connecting') : t('connect')}
            </Button>
          ) : (
            <>
              {state === 'checking' ? (
                <Button size="sm" disabled>
                  <ChromeButtonMark />
                  {t('add')}
                </Button>
              ) : (
                <Button asChild size="sm">
                  <a href={KORTIX_EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
                    <ChromeButtonMark />
                    {t('add')}
                  </a>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
              >
                {t('installedConnect')}
              </Button>
            </>
          )}
        </div>
      </div>
      <BrowserMock className="rounded-none max-sm:hidden" />
    </section>
  );
}

function ComputerCard({ onOpenComputer }: { onOpenComputer: () => void }) {
  const t = useTranslations('appsModal.computer');
  const { owned } = useOwnsPairedComputer();
  const live = owned.some((machine) => machine.isLive);
  const inShell = typeof window !== 'undefined' && isDesktop();
  const platform = typeof navigator === 'undefined' ? null : detectPlatform(navigator.userAgent);
  const download =
    platform && !isMobilePlatform(platform) ? desktopDownloadUrl(platform) : desktopDownloadUrl();

  return (
    <Card title={t('title')}>
      <AppRow
        icon={LaptopIcon}
        name={t('thisComputer')}
        description={
          live ? (
            <span className="flex items-center gap-1.5">
              <BrowserOnlineDot online />
              {t('connected')}
            </span>
          ) : (
            t('thisComputerDescription')
          )
        }
        action={
          <Button size="sm" variant="secondary" onClick={onOpenComputer}>
            {live ? t('manage') : t('connect')}
          </Button>
        }
      />
      <AppRow
        icon={MonitorIcon}
        name={t('desktop')}
        description={inShell ? t('desktopRunning') : t('desktopDescription')}
        action={
          inShell ? null : (
            <Button asChild size="sm" variant="secondary" className="gap-1.5">
              <a href={download}>
                <DownloadSimpleIcon className="size-3.5 shrink-0" />
                {t('download')}
              </a>
            </Button>
          )
        }
      />
    </Card>
  );
}

function DevelopersCard({ onOpenMcp }: { onOpenMcp: () => void }) {
  const t = useTranslations('appsModal.developers');
  const command = useDeploymentCliInstallCommand(getEnv().VERSION);
  const { copy, copied } = useCopy({ toast: false });

  return (
    <Card title={t('title')}>
      <AppRow
        icon={TerminalWindowIcon}
        name={t('cli')}
        description={t('cliDescription')}
        action={
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => copy(command)}>
            {copied ? <SolidCheckIcon className="size-3.5" /> : null}
            {copied ? t('copied') : t('copy')}
          </Button>
        }
      />
      <AppRow
        icon={PlugsConnectedIcon}
        name={t('mcp')}
        description={t('mcpDescription')}
        action={
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={onOpenMcp}>
            {t('connect')}
            <ArrowUpRightIcon className="size-3.5 shrink-0" />
          </Button>
        }
      />
    </Card>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-popover min-w-0 overflow-hidden rounded-md border">
      <h3 className="px-4 pt-3 pb-1 text-sm font-medium">{title}</h3>
      <ul className="divide-border divide-y">{children}</ul>
    </section>
  );
}

function AppRow({
  icon: RowIcon,
  name,
  description,
  action,
}: {
  icon: Icon;
  name: string;
  description: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
        <RowIcon className="size-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{name}</p>
        <div className="text-muted-foreground truncate text-xs">{description}</div>
      </div>
      {action}
    </li>
  );
}
