'use client';

import type { KortixBrowser } from '@kortix/sdk';
import { useBrowsers } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  PlugsConnectedIcon,
  PuzzlePieceIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { errorToast } from '@/components/ui/toast';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useTranslations } from '@/i18n/use-translations';
import { isDesktop } from '@/lib/desktop';
import { getEnv } from '@/lib/env-config';
import { cn } from '@/lib/utils';
import { BrowserIcon, BrowserLogoTile } from './browser-icon';
import {
  apiOrigin,
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
export function useBrowserConnect() {
  const t = useTranslations('browsers');
  const environment = useSyncExternalStore<Environment>(
    subscribeNever,
    detectEnvironment,
    () => 'checking',
  );
  const ping = useQuery({
    queryKey: ['browser-extension-ping'],
    queryFn: () => pingExtension(),
    enabled: environment === 'supported',
    refetchInterval: 2_000,
    staleTime: 0,
    gcTime: 0,
  });
  const browsers = useBrowsers({ refetchInterval: 3_000 });

  // The browsers that existed when the steps appeared. A browser outside it is
  // the one this person is connecting now.
  const [baseline, setBaseline] = useState<Set<string> | null>(null);
  if (baseline === null && browsers.isSuccess) {
    setBaseline(new Set(browsers.data.map((browser) => browser.id)));
  }
  const status = ping.data ?? null;
  const connected: KortixBrowser | undefined =
    browsers.data?.find((browser) => baseline && !baseline.has(browser.id)) ??
    // The extension keeps its browser id after a sign-out: trust it only while signed in.
    (status?.connected && status.browserId
      ? browsers.data?.find((browser) => browser.id === status.browserId && browser.online)
      : undefined);

  const connect = useMutation({
    // A retry would open the sign-in window again.
    retry: false,
    mutationFn: () => connectExtension(apiOrigin(getEnv().BACKEND_URL || '', window.location.origin)),
    onSuccess: (result) => {
      if (!result.ok) errorToast(t('connectFailed'));
      void ping.refetch();
      void browsers.refetch();
    },
  });

  return {
    environment,
    /** The first ping has not answered yet. */
    checking: environment === 'checking' || (environment === 'supported' && !ping.isFetched),
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

export function BrowserOnlineDot({ online, className }: { online: boolean; className?: string }) {
  const t = useTranslations('browsers');
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

/**
 * The three steps and the one action that moves them: Add to Chrome, Connect,
 * Done. Used in the connect dialog and, with no browser connected yet, inline
 * in Settings › Chrome extension.
 */
export function BrowserConnectSteps({ onDone }: { onDone?: () => void }) {
  const t = useTranslations('browsers');
  const { environment, checking, installed, signedIn, connected, connect } = useBrowserConnect();
  const [openedStore, setOpenedStore] = useState(false);

  if (environment === 'unsupported') {
    return (
      <div className="mt-auto space-y-3">
        <p className="text-muted-foreground text-sm text-pretty">{t('unsupported')}</p>
        <Button asChild variant="secondary" size="lg" className="w-full">
          <a href={KORTIX_EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
            <ArrowSquareOutIcon className="size-4 shrink-0" />
            {t('openStore')}
          </a>
        </Button>
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
      description: t(installed ? 'steps.install.done' : 'steps.install.description'),
    },
    {
      key: 'connect',
      icon: PlugsConnectedIcon,
      done: signedIn,
      description: t(signedIn ? 'steps.connect.done' : 'steps.connect.description'),
    },
    {
      key: 'done',
      icon: PlugsConnectedIcon,
      done: Boolean(connected),
      brand: connected?.brand,
      description: connected ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <BrowserOnlineDot online={connected.online} />
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
              <div className="text-muted-foreground truncate text-xs">{description}</div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-auto space-y-2">
        {connected ? (
          onDone ? (
            <Button size="lg" className="w-full" onClick={onDone}>
              {t('done')}
            </Button>
          ) : null
        ) : installed ? (
          <Button
            size="lg"
            className="w-full"
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {connect.isPending ? t('connecting') : t('connect')}
          </Button>
        ) : (
          <>
            {checking ? (
              <Button size="lg" className="w-full" disabled>
                <ChromeButtonMark />
                {t('addToChrome')}
              </Button>
            ) : (
              <Button asChild size="lg" className="w-full">
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
            )}
            {openedStore ? (
              <p className="text-muted-foreground text-center text-xs text-pretty">{t('finishInChrome')}</p>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/**
 * "Add Kortix to Chrome": add the Kortix extension to Chrome, sign it in, and
 * watch the browser appear. Same frame as `ComputerConnectModal`.
 */
export function BrowserConnectModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('browsers');
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
              <ModalDescription className="text-pretty">{t('connectDescription')}</ModalDescription>
            </header>
            {open ? <BrowserConnectSteps onDone={() => onOpenChange(false)} /> : null}
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}
