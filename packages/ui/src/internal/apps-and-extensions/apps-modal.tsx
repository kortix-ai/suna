'use client';

/**
 * "Apps and extensions": every way to use Kortix outside this tab, in one
 * dialog. Chrome first, then the computer, then the developer surfaces. Each
 * row opens the dialog that already owns the flow (computer, MCP, Settings →
 * Kortix in Chrome); nothing here pairs or connects by itself.
 *
 * It is mounted once, in the project sidebar, next to its only triggers: the
 * workspace menu row, the sidebar row and `?apps=1`. Outside a project there is
 * no workspace menu and no sidebar, so `?apps=1` there does nothing.
 */

import { useChromeConnections } from '@kortix/sdk/react';
import {
  ArrowUpRightIcon,
  DownloadSimpleIcon,
  LaptopIcon,
  MonitorIcon,
  PlugsConnectedIcon,
  TerminalWindowIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useId, type ReactNode } from 'react';

import { Button } from '../../primitives/button';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '../../primitives/modal';
import {
  ChromeCopyLink,
  ChromeInstallActions,
  ChromeOnlineDot,
  useChromeConnect,
} from '../chrome/chrome-connect';
import { BrowserLogoTile } from '../chrome/browser-icon';
import { ChromeMock } from '../chrome/chrome-mock';
import { chromeCardState } from '../chrome/chrome-card-state';
import { chromeCounts } from '../chrome/chrome-names';
import { SolidCheckIcon } from '../icons/solid-check-icon';
import { detectPlatform, isMobilePlatform } from '../lib/detect-os';
import { useOwnsPairedComputer } from '../tunnel/computer-connect';
import { errorToast } from '../../primitives/toast';
import { useCopy } from '../hooks/use-copy';
import { useTranslations } from '../../i18n';
import { desktopDownloadUrl, isDesktop } from '../lib/desktop';
import {
  useUiHostConfig,
  useUiPathname,
  useUiRouter,
  useUiSearchParams,
} from '../../providers/ui-provider';
import { useDeploymentCliInstallCommand } from '../lib/use-deployment-cli-install-command';
import { useAppsModalStore } from '../stores/apps-modal-store';
import { useSettingsPanelStore } from '../stores/settings-panel-store';

/** Opens the dialog from `?apps=1` and removes the parameter. */
export function useAppsDeepLink() {
  const params = useUiSearchParams();
  const pathname = useUiPathname();
  const router = useUiRouter();
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
  chrome,
  onOpenComputer,
  onOpenMcp,
}: {
  /** The project's `chrome` flag: the Kortix in Chrome card shows only with it on. */
  chrome: boolean;
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
        <div className="flex flex-col gap-6 p-5 lg:p-8">
          <header className="space-y-1.5 pr-10">
            <ModalTitle className="text-xl font-medium text-balance">{t('title')}</ModalTitle>
            <ModalDescription className="text-muted-foreground text-sm text-pretty">
              {t('subtitle')}
            </ModalDescription>
          </header>
          {open ? (
            <>
              {chrome ? <ChromeSection onManage={() => setOpen(false)} /> : null}
              <ComputerSection onOpenComputer={hand(onOpenComputer)} />
              <DevelopersSection onOpenMcp={hand(onOpenMcp)} />
            </>
          ) : null}
        </div>
      </ModalContent>
    </Modal>
  );
}

/** The hero decides from THIS browser first. Other browsers are one line plus Manage. */
function ChromeSection({ onManage }: { onManage: () => void }) {
  const t = useTranslations('appsModal.chrome');
  const state = useChromeConnect();
  const { environment, checking, installed, signedIn, connected } = state;
  const connections = useChromeConnections();
  const { count, online } = chromeCounts(connections.data ?? []);
  const cardState = chromeCardState({
    thisBrowserConnected: Boolean(connected),
    environment,
    checking,
    installed: installed || signedIn,
  });
  const manage = (
    <Button
      size="sm"
      variant="secondary"
      aria-label={t('manageLabel')}
      onClick={() => {
        onManage();
        useSettingsPanelStore.getState().openSettings('chrome');
      }}
    >
      {t('manage')}
    </Button>
  );

  return (
    <section aria-labelledby="apps-modal-browser" className="space-y-3">
      <h3 id="apps-modal-browser" className="text-muted-foreground text-xs font-medium">
        {t('group')}
      </h3>
      <div className="grid items-center gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <BrowserLogoTile brand="chrome" className="size-7" iconClassName="size-4" />
              <h4 className="text-base font-medium">{t('name')}</h4>
            </div>
            <p className="text-muted-foreground text-sm text-pretty">{t('description')}</p>
          </div>

          {cardState === 'connected' && connected ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {manage}
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <ChromeOnlineDot online={connected.online} />
                <span className="truncate">{connected.name}</span>
                {count > 1 ? (
                  <span className="text-muted-foreground shrink-0">· {t('summary', { count, online })}</span>
                ) : null}
              </span>
            </div>
          ) : (
            <>
              {cardState === 'unsupported' ? (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs text-pretty">{t('unsupported')}</p>
                  <ChromeCopyLink />
                </div>
              ) : (
                <ChromeInstallActions state={state} />
              )}
              {count > 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-muted-foreground text-xs">{t('summary', { count, online })}</span>
                  {manage}
                </div>
              ) : null}
            </>
          )}
        </div>
        <ChromeMock />
      </div>
    </section>
  );
}

function ComputerSection({ onOpenComputer }: { onOpenComputer: () => void }) {
  const t = useTranslations('appsModal.computer');
  const { owned } = useOwnsPairedComputer();
  const live = owned.some((machine) => machine.isLive);
  const inShell = typeof window !== 'undefined' && isDesktop();
  const platform = typeof navigator === 'undefined' ? null : detectPlatform(navigator.userAgent);
  const download =
    platform && !isMobilePlatform(platform) ? desktopDownloadUrl(platform) : desktopDownloadUrl();

  return (
    <Group title={t('title')}>
      <AppRow
        icon={LaptopIcon}
        name={t('thisComputer')}
        description={
          live ? (
            <span className="flex items-center gap-1.5">
              <ChromeOnlineDot online />
              {t('connected')}
            </span>
          ) : (
            t('thisComputerDescription')
          )
        }
        action={
          <Button
            size="sm"
            variant="secondary"
            aria-label={t(live ? 'manageLabel' : 'connectLabel')}
            onClick={onOpenComputer}
          >
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
    </Group>
  );
}

function DevelopersSection({ onOpenMcp }: { onOpenMcp: () => void }) {
  const t = useTranslations('appsModal.developers');
  const command = useDeploymentCliInstallCommand(useUiHostConfig().deploymentVersion);
  const { copy, copied } = useCopy({ toast: false });
  const copyCommand = async () => {
    if (!(await copy(command))) errorToast(t('copyFailed'));
  };

  return (
    <Group title={t('title')}>
      <AppRow
        icon={TerminalWindowIcon}
        name={t('cli')}
        description={t('cliDescription')}
        action={
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={copyCommand}>
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
          <Button
            size="sm"
            variant="secondary"
            className="gap-1.5"
            aria-label={t('connectLabel')}
            onClick={onOpenMcp}
          >
            {t('connect')}
            <ArrowUpRightIcon className="size-3.5 shrink-0" />
          </Button>
        }
      />
    </Group>
  );
}

/** A muted label over plain rows: no card, no border, one rule between rows. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-1">
      <h3 id={id} className="text-muted-foreground text-xs font-medium">
        {title}
      </h3>
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
    <li className="flex items-center gap-3 py-3">
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
        <RowIcon className="size-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{name}</p>
        <div className="text-muted-foreground line-clamp-2 text-xs text-pretty">{description}</div>
      </div>
      {action}
    </li>
  );
}
