'use client';

import { platformConfig, type ChromeConnection } from '@kortix/sdk';
import { useChromeConnections } from '@kortix/sdk/react';
import {
  AppWindowIcon,
  ArrowUpRightIcon,
  LinkSimpleIcon,
  PuzzlePieceIcon,
  SignInIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';

import { Button } from '../../primitives/button';
import Loading from '../../primitives/loading';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '../../primitives/modal';
import { BeamsShader } from '../../primitives/paper-wallpaper-shaders';
import { errorToast } from '../../primitives/toast';
import { SolidCheckIcon } from '../icons/solid-check-icon';
import { useCopy } from '../hooks/use-copy';
import { useTranslations } from '../../i18n';
import { isDesktop } from '../lib/desktop';
import { cn } from '../lib/utils';
import { BrowserIcon, BrowserLogoTile } from './browser-icon';
import {
  apiOrigin,
  CHROME_INSTALL_DOCS_PATH,
  CHROME_STORE_LISTED,
  chromeSettingsLink,
  connectExtension,
  isChromiumBrowser,
  KORTIX_EXTENSION_STORE_URL,
  pingExtension,
} from './extension';

type Environment = 'checking' | 'supported' | 'unsupported';

const subscribeNever = () => () => {};
function detectEnvironment(): Environment {
  return isChromiumBrowser(navigator.userAgent) && !isDesktop() ? 'supported' : 'unsupported';
}

/**
 * The live state of the three steps: the extension is installed (ping every
 * 2 s), the extension is signed in, and the new browser shows in the list
 * (poll every 3 s). Mount it only while the steps are on screen.
 */
export type ChromeConnectState = ReturnType<typeof useChromeConnect>;

/**
 * `fresh`: the person adds ANOTHER browser. This browser's own extension state
 * does not count: no ping, and only a browser that was not in the list when the
 * dialog opened completes it.
 */
export function useChromeConnect({ fresh = false }: { fresh?: boolean } = {}) {
  const t = useTranslations('chrome');
  const environment = useSyncExternalStore<Environment>(
    subscribeNever,
    detectEnvironment,
    () => 'checking',
  );
  const ping = useQuery({
    queryKey: ['chrome-extension-ping'],
    queryFn: () => pingExtension(),
    enabled: environment === 'supported' && !fresh,
    refetchInterval: 2_000,
    staleTime: 0,
    gcTime: 0,
  });
  const connections = useChromeConnections({ refetchInterval: 3_000 });

  // The browsers that existed when the steps appeared. A browser outside it is
  // the one this person is connecting now.
  const [baseline, setBaseline] = useState<Set<string> | null>(null);
  if (baseline === null && connections.isSuccess) {
    setBaseline(new Set(connections.data.map((chrome) => chrome.id)));
  }
  const status = fresh ? null : (ping.data ?? null);
  const connected: ChromeConnection | undefined =
    connections.data?.find((chrome) => baseline && !baseline.has(chrome.id)) ??
    // The extension keeps its browser id after a sign-out: trust it only while signed in.
    (status?.connected && status.chromeId
      ? connections.data?.find((chrome) => chrome.id === status.chromeId && chrome.online)
      : undefined);

  const connect = useMutation({
    // A retry would open the sign-in window again.
    retry: false,
    mutationFn: () => connectExtension(apiOrigin(platformConfig().backendUrl || '', window.location.origin)),
    onSuccess: (result) => {
      if (!result.ok) {
        // `unavailable`: the page could not reach the extension.
        errorToast(t(result.error === 'unavailable' ? 'extensionMissing' : 'connectFailed'));
      }
      void ping.refetch();
      void connections.refetch();
    },
  });

  return {
    environment,
    /** The first ping has not answered yet. */
    checking: environment === 'checking' || (environment === 'supported' && !fresh && !ping.isFetched),
    // A page opened before the install cannot reach the extension until it
    // reloads. The extension's own tab finishes the sign-in, and the browser
    // then shows up in the list, so a connected browser completes every step.
    installed: status !== null || Boolean(connected),
    signedIn: status?.connected === true || Boolean(connected),
    connected,
    connect,
  };
}

/** The Chrome mark on a small white tile, for a button label. */
export function ChromeButtonMark() {
  return <BrowserLogoTile brand="chrome" className="size-5 shrink-0 ring-0" iconClassName="size-3.5" />;
}

function StepTile({ done, icon: StepIcon, brand }: { done: boolean; icon: Icon; brand?: string }) {
  // The last step shows the connected browser's own mark.
  if (done && brand) return <BrowserLogoTile brand={brand} className="size-10" />;
  return (
    <span
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-sm',
        done ? 'bg-kortix-green/15' : 'bg-muted text-muted-foreground',
      )}
    >
      {done ? <SolidCheckIcon className="text-kortix-green size-5" /> : <StepIcon className="size-5" />}
    </span>
  );
}

export function ChromeOnlineDot({ online, className }: { online: boolean; className?: string }) {
  const t = useTranslations('chrome');
  return (
    <span
      role="img"
      aria-label={online ? t('online') : t('offline')}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        online ? 'bg-kortix-green' : 'bg-muted-foreground',
        className,
      )}
    />
  );
}

/** Copies the link that opens Settings → Kortix in Chrome, for a browser that cannot run the extension. */
export function ChromeCopyLink({ size = 'sm', className }: { size?: 'sm' | 'lg'; className?: string }) {
  const t = useTranslations('chrome');
  const { copy, copied } = useCopy({ toast: false });
  return (
    <Button
      variant="secondary"
      size={size}
      className={cn('gap-1.5', className)}
      onClick={async () => {
        if (!(await copy(chromeSettingsLink(window.location.origin)))) errorToast(t('copyFailed'));
      }}
    >
      {copied ? <SolidCheckIcon className="size-3.5 shrink-0" /> : <LinkSimpleIcon className="size-3.5 shrink-0" />}
      {copied ? t('linkCopied') : t('copyLink')}
    </Button>
  );
}

/**
 * The action that moves this browser forward: Connect once the extension is
 * there, otherwise Connect plus "How to install" (or "Add to Chrome" once the
 * Web Store listing is public). Renders nothing for a connected browser.
 */
export function ChromeInstallActions({
  state,
  size = 'sm',
  className,
  showGuide = true,
}: {
  state: ChromeConnectState;
  size?: 'sm' | 'lg';
  className?: string;
  /** The "How to install" link. Off where the page already links the docs. */
  showGuide?: boolean;
}) {
  const t = useTranslations('chrome');
  const { checking, installed, connected, connect } = state;
  const [openedStore, setOpenedStore] = useState(false);
  if (connected) return null;
  const full = size === 'lg' ? 'w-full' : '';

  const connectButton = (
    <Button size={size} className={full} disabled={connect.isPending} onClick={() => connect.mutate()}>
      {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
      {connect.isPending ? t('connecting') : t('connect')}
    </Button>
  );

  if (installed) return <div className={className}>{connectButton}</div>;

  if (CHROME_STORE_LISTED) {
    return (
      <div className={cn('space-y-2', className)}>
        <Button asChild size={size} className={full} aria-disabled={checking}>
          <a
            href={KORTIX_EXTENSION_STORE_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpenedStore(true)}
          >
            <ChromeButtonMark />
            {t('addToChrome')}
          </a>
        </Button>
        {openedStore ? (
          <p className="text-muted-foreground text-center text-xs text-pretty">{t('finishInChrome')}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        size === 'lg' ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-x-3 gap-y-2',
        className,
      )}
    >
      {connectButton}
      {showGuide ? (
        <Button asChild variant="ghost" size={size} className={cn('gap-1.5', size === 'sm' && 'text-muted-foreground')}>
          <a href={CHROME_INSTALL_DOCS_PATH} target="_blank" rel="noreferrer">
            {t('howToInstall')}
            <ArrowUpRightIcon className="size-3.5 shrink-0" />
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The three steps and the one action that moves them. Used in the connect
 * dialog and, with no browser connected yet, inline in Settings → Kortix in
 * Chrome (`showActions={false}`: the page header holds the action there).
 */
export function ChromeConnectSteps({
  state,
  onDone,
  showActions = true,
}: {
  state: ChromeConnectState;
  onDone?: () => void;
  showActions?: boolean;
}) {
  const t = useTranslations('chrome');
  const { environment, installed, signedIn, connected } = state;

  if (environment === 'unsupported') {
    return (
      <div className="mt-auto space-y-3">
        <p className="text-muted-foreground text-sm text-pretty">{t('unsupported')}</p>
        {showActions ? <ChromeCopyLink size="lg" className="w-full" /> : null}
      </div>
    );
  }

  const steps: {
    key: 'install' | 'connect' | 'done';
    icon: Icon;
    done: boolean;
    brand?: string;
    description: React.ReactNode;
  }[] = [
    {
      key: 'install',
      icon: PuzzlePieceIcon,
      done: installed,
      description: installed ? (
        t('steps.install.done')
      ) : CHROME_STORE_LISTED ? (
        t('steps.install.description')
      ) : (
        <>
          {t('steps.install.descriptionUnlisted')}
          {/* The dialog's action row links the guide itself; the inline page has no such row. */}
          {showActions ? null : (
            <>
              {' '}
              <a
                href={CHROME_INSTALL_DOCS_PATH}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline underline-offset-2"
              >
                {t('howToInstall')}
              </a>
            </>
          )}
        </>
      ),
    },
    {
      key: 'connect',
      icon: SignInIcon,
      done: signedIn,
      description: t(signedIn ? 'steps.connect.done' : 'steps.connect.description'),
    },
    {
      key: 'done',
      icon: AppWindowIcon,
      done: Boolean(connected),
      brand: connected?.brand,
      description: connected ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <ChromeOnlineDot online={connected.online} />
          <span className="truncate">{connected.name}</span>
        </span>
      ) : (
        t('steps.done.description')
      ),
    },
  ];

  return (
    <>
      <ol className="divide-border divide-y">
        {steps.map(({ key, icon, done, brand, description }) => (
          <li key={key} className="flex items-center gap-3 py-3">
            <StepTile done={done} icon={icon} brand={brand} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">{t(`steps.${key}.title`)}</p>
              <div className="text-muted-foreground line-clamp-2 text-xs text-pretty">{description}</div>
            </div>
          </li>
        ))}
      </ol>

      {showActions || connected ? (
        <div className="mt-auto space-y-2">
          {connected ? (
            onDone ? (
              <Button size="lg" className="w-full" onClick={onDone}>
                {t('done')}
              </Button>
            ) : null
          ) : (
            <ChromeInstallActions state={state} size="lg" />
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * "Add another browser": the other browser, or another Chrome profile, signs
 * itself in. This page cannot do that for it, so the dialog says where to go
 * and waits for the new browser to show up in the list.
 */
function ChromeAddAnother({ onDone }: { onDone?: () => void }) {
  const t = useTranslations('chrome');
  const { connected } = useChromeConnect({ fresh: true });
  return (
    <>
      <ol className="divide-border divide-y">
        <li className="flex items-center gap-3 py-3">
          <StepTile done={Boolean(connected)} icon={AppWindowIcon} brand={connected?.brand} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">{t('another.title')}</p>
            <div className="text-muted-foreground line-clamp-2 text-xs text-pretty">
              {connected ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <ChromeOnlineDot online={connected.online} />
                  <span className="truncate">{connected.name}</span>
                </span>
              ) : (
                t('another.waiting')
              )}
            </div>
          </div>
        </li>
      </ol>
      <div className="mt-auto space-y-2">
        {connected ? (
          onDone ? (
            <Button size="lg" className="w-full" onClick={onDone}>
              {t('done')}
            </Button>
          ) : null
        ) : (
          <ChromeCopyLink size="lg" className="w-full" />
        )}
      </div>
    </>
  );
}

function ChromeConnectBody({ onDone }: { onDone: () => void }) {
  const state = useChromeConnect();
  return <ChromeConnectSteps state={state} onDone={onDone} />;
}

/**
 * "Add Kortix to Chrome": add the Kortix extension to Chrome, sign it in, and
 * watch the browser appear. `fresh`: add ANOTHER browser. Same frame as
 * `ComputerConnectModal`.
 */
export function ChromeConnectModal({
  open,
  onOpenChange,
  fresh = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fresh?: boolean;
}) {
  const t = useTranslations('chrome');
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        className="space-y-0 lg:max-w-3xl"
        closeClassName="max-sm:bg-background border-0 overflow-hidden"
      >
        {/* Same split frame as ComputerConnectModal: art beside the content
            from `sm`, a short banner above it on a phone. */}
        <div className="grid sm:grid-cols-5 lg:min-h-128">
          <div
            aria-hidden="true"
            className="dark bg-background relative isolate flex h-48 items-center justify-center overflow-hidden rounded-t-xl border-b sm:col-span-2 sm:h-auto sm:rounded-tr-none sm:border-r sm:border-b-0 lg:rounded-bl-xl"
          >
            <BeamsShader />
            <span className="bg-foreground text-background relative flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium">
              <BrowserIcon brand="chrome" tone="current" className="size-4" />
              {t('pill')}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-5 p-5 sm:col-span-3 lg:p-8">
            <header className="space-y-1.5 pr-10">
              <ModalTitle className="text-lg font-medium text-balance">{t('connectTitle')}</ModalTitle>
              <ModalDescription className="text-pretty">
                {t(fresh ? 'another.description' : 'connectDescription')}
              </ModalDescription>
            </header>
            {open ? (
              fresh ? (
                <ChromeAddAnother onDone={() => onOpenChange(false)} />
              ) : (
                <ChromeConnectBody onDone={() => onOpenChange(false)} />
              )
            ) : null}
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}
