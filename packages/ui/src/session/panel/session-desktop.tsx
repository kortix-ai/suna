'use client';

/**
 * `SessionDesktop` — the session computer's screen, live.
 *
 * Every session image runs a desktop that voxl streams on port 6901
 * (`packages/shared/src/sandbox/desktop.ts`). This frames voxl's own web
 * client through the sandbox proxy, the same way `AppPreview` frames a port.
 *
 * Control is explicit, and the screen says who has it. Kortix has it by
 * default: a transparent shield takes every pointer and key, so a user who
 * scrolls or clicks past the panel never moves the agent's mouse. "Take over"
 * (or a click on the screen) drops the shield, rings the screen and focuses
 * it; "Return control" puts the shield back.
 *
 * The frame unmounts while this browser tab is hidden. voxl paces every
 * viewer to the slowest one, and a background tab stops acking frames, so a
 * forgotten tab would slow the stream for everyone watching. It reconnects,
 * on a fresh keyframe, when the tab is shown again.
 *
 * A computer without a desktop (My Kortix's minimal image, a template on
 * another base) says so; the header does not offer the panel there. The
 * control bar appears only once the desktop answers, never over the proxy's
 * "not answering" page.
 */

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import Loading from '../../primitives/loading';
import { useSandboxProxy } from '../../internal/hooks/use-sandbox-proxy';
import { usePreviewFrameUrl } from '../../internal/hooks/use-preview-frame-url';
import { useIsMobile } from '../../internal/hooks';
import { framePolicy } from '../../files/viewer/preview-policy';
import { PanelWidthButton } from '../../files/viewer/viewer-actions';
import { CloseButton, DetailSidebarToggle } from '../../files/viewer/viewer-chrome';
import { cn } from '../../lib/utils';
import { probePreviewPort, type PreviewPortProbe } from '@kortix/sdk';
import { useHasSessionDesktop } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, MonitorIcon } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export const DESKTOP_URL = 'http://localhost:6901/';
/** How often the panel asks again until the desktop answers. */
const PROBE_INTERVAL_MS = 3_000;
/**
 * The proxy answers 502 for a stopped desktop only after ~5 s (measured 4.8 s:
 * it retries the port first). The probe's 3 s default reads that as `unknown`.
 */
const PROBE_TIMEOUT_MS = 10_000;

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
};
const tabVisible = () => document.visibilityState === 'visible';

export function SessionDesktop({
  projectId,
  projectSessionId,
  onClose,
}: {
  projectId?: string;
  projectSessionId?: string;
  onClose: () => void;
}) {
  const t = useTranslations('sessionDesktop');
  const isMobile = useIsMobile();
  const { proxyUrl } = useSandboxProxy();
  const src = usePreviewFrameUrl(DESKTOP_URL, proxyUrl(DESKTOP_URL) ?? DESKTOP_URL, {
    projectId,
    sessionId: projectSessionId,
  }).url;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [control, setControl] = useState(false);
  // `undefined` until the session's daemon answers its health probe.
  const hasDesktop = useHasSessionDesktop();
  // `unreachable` = the proxy answered 502/503/504: nothing listens on 6901.
  const [probe, setProbe] = useState<PreviewPortProbe>('unknown');
  const [attempt, setAttempt] = useState(0);
  const visible = useSyncExternalStore(subscribeVisibility, tabVisible, () => true);
  const live = probe === 'reachable';

  // Ask until the desktop answers. The first answer is often `unknown`: the
  // preview cookie arrives with the frame's first load. A stopped desktop
  // answers `unreachable`, and the panel shows it again once it starts.
  useEffect(() => {
    if (!src || !hasDesktop || !visible) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const result = await probePreviewPort(src, { signal: abort.signal, timeoutMs: PROBE_TIMEOUT_MS });
      if (abort.signal.aborted) return;
      setProbe(result);
      if (result !== 'reachable') timer = setTimeout(ask, PROBE_INTERVAL_MS);
    };
    void ask();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [src, hasDesktop, visible, attempt]);

  const takeOver = () => {
    setControl(true);
    frameRef.current?.focus();
  };

  return (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        <DetailSidebarToggle className="size-7" />
        <MonitorIcon className="text-muted-foreground ml-1 size-3.5 shrink-0" />
        <span className="truncate text-sm font-medium">{t('title')}</span>
        <div className="flex-1" />
        <ButtonGroup className="shrink-0">
          <Button
            variant="secondary"
            size="icon"
            className="size-7"
            disabled={!live}
            aria-label={t('openTab')}
            onClick={() => src && window.open(src, '_blank', 'noopener,noreferrer')}
          >
            <ArrowSquareOutIcon className="size-3.5" />
          </Button>
          <PanelWidthButton isMobile={isMobile} />
          <CloseButton onClose={onClose} />
        </ButtonGroup>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        <div
          data-slot="desktop-screen"
          data-control={control ? 'user' : 'agent'}
          className={cn(
            'bg-muted relative min-h-0 flex-1 overflow-hidden rounded-xl ring-1 ring-border transition-shadow',
            control && 'ring-2 ring-primary',
          )}
        >
          {hasDesktop === false ? (
            <DesktopNotice title={t('noDesktop')} hint={t('noDesktopHint')} />
          ) : probe === 'unreachable' ? (
            <DesktopNotice
              title={t('offline')}
              hint={
                <>
                  {t('start')} <code>kortix-desktop start</code>.
                </>
              }
            >
              <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                {t('retry')}
              </Button>
            </DesktopNotice>
          ) : !hasDesktop || !src || !visible ? (
            <div className="flex h-full items-center justify-center">
              <Loading className="size-4" />
            </div>
          ) : (
            <>
              <iframe
                ref={frameRef}
                src={src}
                title={t('title')}
                className="h-full w-full border-0"
                sandbox={framePolicy('app', src).sandbox}
                allow="clipboard-read; clipboard-write; autoplay; fullscreen"
                tabIndex={control ? 0 : -1}
              />
              {!control && (
                <button
                  type="button"
                  aria-label={t('takeOver')}
                  data-slot="desktop-shield"
                  className="absolute inset-0 cursor-pointer"
                  onClick={takeOver}
                />
              )}
            </>
          )}
        </div>

        <div className="flex h-9 shrink-0 items-center justify-center gap-3 text-sm">
          {live && (
            <>
              <span className="text-muted-foreground">
                {control ? t('userControl') : t('agentControl')}
              </span>
              <Button
                variant={control ? 'secondary' : 'default'}
                size="sm"
                className="h-7 rounded-full px-3"
                aria-pressed={control}
                onClick={control ? () => setControl(false) : takeOver}
              >
                {control ? t('returnControl') : t('takeOver')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DesktopNotice({ title, hint, children }: { title: string; hint: ReactNode; children?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm">
      <MonitorIcon className="size-10 opacity-20" />
      <p>{title}</p>
      <p className="text-xs">{hint}</p>
      {children}
    </div>
  );
}
