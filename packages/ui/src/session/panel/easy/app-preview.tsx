'use client';

import { useTranslations } from '../../../i18n';
/**
 * `AppPreview` — the running thing, opened.
 *
 * When someone asks for a landing page, a dashboard, a React app, the
 * deliverable isn't a file on disk — it's a server on a port. Easy mode has no
 * tab strip, so before this there was no way to reach it at all: the one output
 * the user actually wanted was the one they couldn't get to.
 *
 * `BrowserPanel`'s chrome lives in `../../../browser/sandbox-browser-chrome` — this
 * surface keeps a tab-store-free history (mounting `BrowserPanel` here would
 * spawn a tab in the app's tab bar as a side effect of opening an output) and
 * hands the shared chrome its model, plus the "port may not be running yet"
 * retry below.
 *
 * The address bar controls the sandbox's own PORTS, not the open web — the same
 * rule `BrowserPanel` enforces, and for the same reason: this is a window onto
 * your sandbox, not a browser.
 */

import { Button } from '../../../primitives/button';
import { ButtonGroup } from '../../../primitives/button-group';
import Hint from '../../../primitives/hint';
import Loading from '../../../primitives/loading';
import { useAppInBrowser, withoutAppAccessToken } from '../../../browser/app-in-browser';
import { framePolicy } from '../../../files/viewer/preview-policy';
import { ErrorState } from '../../../primitives/error-state';
import { useSandboxProxy } from '../../../internal/hooks/use-sandbox-proxy';
import { usePreviewFrameUrl } from '../../../internal/hooks/use-preview-frame-url';
import { useIsMobile } from '../../../internal/hooks';
import { track } from '../../../lib/telemetry';
import { focusWithoutScroll } from '../../../internal/lib/utils/focus-without-scroll';
import { parseLocalhostUrl, toInternalUrl } from '@kortix/sdk';
import { useBrowserRecentsStore } from '../../../internal/stores/browser-recents-store';
import { type CreateSessionPublicShareInput, probePreviewPort } from '@kortix/sdk';
import { useRuntimeConnectionStore } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  GlobeIcon as Globe,
  SparkleIcon as SparklesSolid,
  WarningIcon,
} from '@phosphor-icons/react';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  PreviewLoadingOverlay,
  SandboxAddressBar,
} from '../../../browser/sandbox-browser-chrome';
import { BrowserLanding } from '../../../browser/browser-landing';
import { CloseButton, DetailSidebarToggle } from './detail-view';
import {
  PREVIEW_MAX_WAIT_MS,
  PREVIEW_SLOW_MS,
  PREVIEW_PROBE_INTERVAL_MS,
  type PreviewProbe,
  type SandboxHealth,
  previewErrorReason,
  previewSlowReason,
  previewLoadSuccessState,
  previewLoadVerdict,
  runtimeSandboxHealth,
  sandboxRecents,
  shouldArmLoadTimeout,
  shouldKeepProbingPort,
} from './easy-panel-logic';
import { PanelWidthButton, type ShareContext, ViewerActions } from '../../../files/viewer/viewer-actions';

// zustand v5's own hook feeds React's `useSyncExternalStore` a
// `getServerSnapshot` pinned to `getInitialState()` — correct for real SSR
// (sandbox health can only ever be learned from a client-side poll, so it is
// genuinely "connecting" at request time), but it means a real server-render
// dispatcher can never observe a `setState` call that happened earlier in the
// same process, as this component's render tests need to. Reading through
// `getState()` for both snapshots sidesteps that — same live value, same
// reactivity via `subscribe`, no behavior change in the browser or real SSR.
const getSandboxHealthSnapshot = (): SandboxHealth => {
  const s = useRuntimeConnectionStore.getState();
  return runtimeSandboxHealth({
    status: s.status,
    healthy: s.healthy,
    initialCheckDone: s.initialCheckDone,
  });
};

export function AppPreview({
  url,
  name,
  projectId,
  shareContext,
  onClose,
  onSendToAgent,
}: {
  /** The internal sandbox URL the agent handed over, e.g. http://localhost:3000. */
  url: string;
  name: string;
  /** Lists the project's Apps on the no-app landing. */
  projectId?: string;
  /** Project-session ids the share link is scoped to. Absent on a booting or
   *  transient session, which is why Copy link is omitted rather than disabled
   *  there — same rule as `ShareFileButton`. */
  shareContext?: ShareContext;
  onClose: () => void;
  /** "Send to agent" — shown in the "Couldn't load" error state next to
   *  Retry, in the merge-conflict "Solve with agent" style. Seeds the session
   *  composer with a prompt asking the agent to bring the app back up. Omitted
   *  entirely (not disabled) when there's no handler — the error screen then
   *  shows only Retry, exactly as before. */
  onSendToAgent?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // The app runs on localhost *inside the sandbox*, which the browser cannot
  // reach. The proxy is what makes it openable at all.
  const { proxyUrl } = useSandboxProxy();

  // History of internal (localhost) URLs. Back/forward are real, not decorative.
  const [history, setHistory] = useState<string[]>([url]);
  const [index, setIndex] = useState(0);
  const current = history[index] ?? url;
  // The quick-view "Open Browser" with no running app hands over url: '' —
  // no port to load, nothing to spin on. Land on the address bar instead.
  const noApp = !current;

  // The landing's "Recents" — the shared history BrowserPanel also shows,
  // filtered to sandbox ports (the only URLs this address bar will open).
  const recents = useBrowserRecentsStore((s) => s.recents);
  const localhostRecents = useMemo(() => sandboxRecents(recents), [recents]);
  const port = useMemo(() => parseLocalhostUrl(current)?.port ?? 0, [current]);

  const proxied = useMemo(() => proxyUrl(current) ?? current, [proxyUrl, current]);
  // Null while the token or the host's URL (`UiProvider resolvePreviewUrl`) resolves.
  const hostPreview = usePreviewFrameUrl(
    current,
    proxied,
    shareContext ?? (projectId ? { projectId } : undefined),
  );
  const authenticatedUrl = hostPreview.url;
  // A project App frames signed in, on its own origin (`useAppInBrowser`).
  const { app, apps, src: previewUrl } = useAppInBrowser(projectId, authenticatedUrl);
  const hasPreview = !!previewUrl;
  // A Kortix App is named by its App, not by its route-key host.
  const title = app?.name ?? name;
  const suggestions = useMemo(() => apps.map((row) => ({ label: row.name, url: row.url })), [apps]);
  const appCopy = useMemo(
    () =>
      app
        ? {
            ariaLabel: tI18nComplete.raw('text9adff6870471'),
            run: () => navigator.clipboard.writeText(withoutAppAccessToken(current)),
          }
        : undefined,
    [app, current, tI18nComplete],
  );

  const [refreshKey, setRefreshKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  // Still loading past PREVIEW_SLOW_MS: the overlay says so and offers Reload.
  const [slow, setSlow] = useState(false);

  const addressRef = useRef<HTMLInputElement>(null);

  // Copy link mints a PUBLIC share and copies `/share/session/{token}`.
  // It used to copy `previewUrl` — the authenticated `/v1/p/{sandbox}/{port}/…`
  // proxy URL — which only ever worked in the tab that had the
  // `__preview_session` cookie. Everyone else got a 401 on a link that also
  // leaked the sandbox id.
  const shareInput = useMemo<CreateSessionPublicShareInput | null>(() => {
    if (port <= 0) return null;
    const path = parseLocalhostUrl(current)?.path || '/';
    return { mode: 'view', preview: { label: name, url: current, port, path } };
  }, [current, name, port]);

  const sandboxHealth = useSyncExternalStore(
    useRuntimeConnectionStore.subscribe,
    getSandboxHealthSnapshot,
    getSandboxHealthSnapshot,
  );

  // ─── The port watch. ─────────────────────────────────────────────────────
  // Cross-origin iframes frequently never fire onLoad OR onError, so both the
  // spinner and the error card would otherwise hang forever. This used to be a
  // flat 5s timer that declared "Couldn't load" on that silence — but silence
  // is not evidence, and a first hit on a cold dev-server route takes 30-60s
  // (CLAUDE.md), so healthy apps were being failed mid-compile.
  //
  // So ask the port instead of watching the clock. The preview proxy answers
  // 502/503/504 ITSELF when it cannot open a connection, which makes a NEGATIVE
  // verdict fast and independent of how slow the app is; a positive verdict is
  // only ever as fast as the app, and the iframe's own onLoad is the better
  // signal for that anyway. `previewLoadVerdict` owns every decision; this is
  // the loop that feeds it (one probe in flight at a time, so a stalled port
  // delays the next probe instead of stacking sockets).
  //
  // Armed only once the iframe actually has a `src` (`hasPreview`): the auth
  // token fetch that produces `previewUrl` can itself take a few seconds, and
  // arming at mount burned that wait against the app's budget.
  useEffect(() => {
    if (!shouldArmLoadTimeout({ isLoading, noApp, hasPreview }) || !previewUrl) return;

    const startedAt = Date.now();
    let unreachableSince = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const controller = new AbortController();

    const fail = () => {
      alive = false;
      setIsLoading(false);
      setHasError(true);
    };

    // Sandbox health is read from the store at decision time, not closed over:
    // it must reach the next tick WITHOUT restarting the watch, or every write
    // by the runtime poll would reset the elapsed clock.
    const decide = (probe: PreviewProbe, waitedMs: number) => {
      const verdict = previewLoadVerdict({
        sandbox: getSandboxHealthSnapshot(),
        probe,
        unreachableForMs: unreachableSince ? Date.now() - unreachableSince : 0,
        waitedMs,
      });
      if (verdict === 'failed') fail();
      return verdict;
    };

    const tick = async () => {
      const probe = await probePreviewPort(previewUrl, { signal: controller.signal });
      if (!alive) return;

      // Continuity, not a count: any answer at all clears the streak, so a
      // server that restarts mid-wait never accumulates its way to an error.
      if (probe === 'unreachable') unreachableSince ||= Date.now();
      else unreachableSince = 0;

      const watchedMs = Date.now() - startedAt;
      if (decide(probe, watchedMs) === 'failed') return;

      const unreachableForMs = unreachableSince ? Date.now() - unreachableSince : 0;
      if (shouldKeepProbingPort({ probe, unreachableForMs, watchedMs })) {
        timer = setTimeout(tick, PREVIEW_PROBE_INTERVAL_MS);
      }
      // Otherwise the probe has said all it can. The iframe's own onLoad and
      // the bound below carry the rest — no more requests at the user's app.
    };

    // The bound gets its own timer rather than riding the poll: a probe that
    // stalls stretches the loop's cadence, and the ceiling must not stretch
    // with it.
    const deadline = setTimeout(() => {
      if (alive) decide('unknown', PREVIEW_MAX_WAIT_MS);
    }, PREVIEW_MAX_WAIT_MS);
    // A stalled request fires no onLoad and the probe cannot see it: say so
    // instead of spinning silently until the deadline (KRTX-3015).
    const slowTimer = setTimeout(() => {
      if (alive) setSlow(true);
    }, PREVIEW_SLOW_MS);

    void tick();

    return () => {
      alive = false;
      controller.abort();
      clearTimeout(deadline);
      clearTimeout(slowTimer);
      if (timer) clearTimeout(timer);
      setSlow(false);
    };
  }, [isLoading, refreshKey, noApp, hasPreview, previewUrl]);

  // Nothing to load, so land the cursor on the address bar — the fastest way
  // in once you know the port. `focusWithoutScroll`: this fires while the
  // detail card is still sliding in from x:100%, and a bare focus() would
  // scroll the panel's overflow-hidden ancestors sideways to reveal it —
  // the stuck-shifted-layout bug.
  useEffect(() => {
    if (noApp) focusWithoutScroll(addressRef.current);
  }, [noApp]);

  const reload = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const navigateTo = useCallback(
    (next: string) => {
      // Feed the shared recents (the same list BrowserPanel's landing shows)
      // so the port map builds up from either surface.
      useBrowserRecentsStore.getState().addRecent(next);
      setHistory((prev) => [...prev.slice(0, index + 1), next]);
      setIndex((i) => i + 1);
      reload();
    },
    [index, reload],
  );

  const canGoBack = index > 0;
  const canGoForward = index < history.length - 1;

  const goBack = useCallback(() => {
    if (!canGoBack) return;
    setIndex((i) => i - 1);
    reload();
  }, [canGoBack, reload]);

  const goForward = useCallback(() => {
    if (!canGoForward) return;
    setIndex((i) => i + 1);
    reload();
  }, [canGoForward, reload]);

  return (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      <AppPreviewToolbar
        previewUrl={previewUrl}
        onClose={onClose}
        displayValue={current}
        isLoading={isLoading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onHome={() => navigateTo('')}
        onNavigate={navigateTo}
        suggestions={suggestions}
        inputRef={addressRef}
        trailing={
          // An app has no file to save and no text to put on a clipboard, so
          // `Copy link` is the one copy action — the thing you can hand
          // someone for a running port.
          <ViewerActions copy={appCopy} shareContext={shareContext} shareInput={shareInput} />
        }
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {isLoading && hasPreview && !noApp && (
          <PreviewLoadingOverlay
            label={tI18nComplete.raw('textc4cf2b2ccb5d')}
            detail={slow ? previewSlowReason({ port }) : undefined}
            action={
              slow ? (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={reload}>
                  {tI18nComplete.raw('textbdc090ec61e3')}
                </Button>
              ) : undefined
            }
          />
        )}

        {(hasError || hostPreview.failed) && !noApp && (
          <ErrorState
            icon={WarningIcon}
            size="sm"
            className="bg-background absolute inset-0 z-10"
            title={tI18nComplete('textba601cdb484b', { value0: title })}
            /* The single most common cause, said plainly: the agent started the
               server a moment ago and it isn't listening yet. Only a SETTLED
               `dead` verdict earns the stopped-workspace wording — see
               `previewErrorReason`. */
            description={previewErrorReason({ sandbox: sandboxHealth, port })}
            action={
              <Button variant="outline" size="sm" className="gap-1.5" onClick={reload}>
                {tI18nComplete.raw('text942087cc2d41')}
              </Button>
            }
            secondaryAction={
              onSendToAgent ? (
                <Button size="sm" className="gap-1.5" onClick={onSendToAgent}>
                  <SparklesSolid weight="fill" className="size-3.5 shrink-0" />
                  {tI18nComplete.raw('text77a860cbc585')}
                </Button>
              ) : null
            }
          />
        )}

        {noApp ? (
          /* Landing — the project's Apps and recent ports as one timeline
             (`BrowserLanding`); a quiet search hint when there is neither. */
          <div className="flex h-full flex-col overflow-y-auto">
            <BrowserLanding
              projectId={projectId}
              recents={localhostRecents}
              empty={<SearchHint />}
              onOpen={(url) => {
                const parsed = parseLocalhostUrl(url);
                navigateTo(parsed ? toInternalUrl(parsed.port, parsed.path) : url);
              }}
            />
          </div>
        ) : hasPreview ? (
          <iframe
            key={refreshKey}
            src={previewUrl}
            title={title}
            className="h-full w-full border-0"
            sandbox={framePolicy('app', previewUrl).sandbox}
            onLoad={() => {
              // A load is positive evidence the app is up, which overrides a
              // `hasError` an earlier verdict set — otherwise the error card
              // (absolute inset-0 z-10) keeps covering a working app until a
              // manual Retry (see `previewLoadSuccessState`). Clearing
              // `isLoading` also disarms the port watch: its effect is gated on
              // `shouldArmLoadTimeout`, so the state change tears it down.
              const next = previewLoadSuccessState();
              setIsLoading(next.isLoading);
              setHasError(next.hasError);
            }}
            onError={() => {
              // A real error event is its own evidence — no probe needed.
              setIsLoading(false);
              setHasError(true);
            }}
          />
        ) : (
          // Auth token still resolving. A spinner, not an empty frame — an empty
          // frame reads as "your app is broken".
          <div className="flex h-full items-center justify-center">
            <Loading className="size-4" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Browser card's toolbar: sidebar toggle, address bar, open in a new tab,
 * width, close. Shared by the live preview and the booting card, so the two
 * cannot drift.
 */
function AppPreviewToolbar({
  previewUrl,
  onClose,
  ...address
}: Omit<ComponentProps<typeof SandboxAddressBar>, 'hasPreview' | 'placeholder'> & {
  previewUrl?: string | null;
  onClose: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isMobile = useIsMobile();
  return (
    <div className="border-border flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
      <DetailSidebarToggle />
      <SandboxAddressBar
        {...address}
        hasPreview={!!previewUrl}
        placeholder={tI18nComplete.raw('text878abd024f27')}
      />

      {/* Opening the app in a real browser tab is the only capability the
          panel itself cannot offer, so it is a visible control outside the
          pill. */}
      <ButtonGroup className="shrink-0">
        <Hint label={tI18nComplete.raw('text306ef19c8ac3')} side="bottom">
          <Button
            variant="secondary"
            size="icon"
            disabled={!previewUrl}
            aria-label={tI18nComplete.raw('text306ef19c8ac3')}
            onClick={() => {
              if (!previewUrl) return;
              track('app_opened_new_tab');
              window.open(previewUrl, '_blank', 'noopener,noreferrer');
            }}
            className="size-7 shrink-0 active:scale-[0.96]"
          >
            <ArrowSquareOutIcon className="size-3.5" />
          </Button>
        </Hint>

        <PanelWidthButton isMobile={isMobile} />

        <CloseButton onClose={onClose} />
      </ButtonGroup>
    </div>
  );
}

const noop = () => {};

/**
 * The Browser card while the session's computer boots: the real toolbar, every
 * control that needs the computer disabled, over `children` (the boot status).
 * Mounts nothing that reaches the sandbox: no proxy, no app list, no frame.
 */
export function AppPreviewBooting({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const addressRef = useRef<HTMLInputElement>(null);
  return (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      <AppPreviewToolbar
        onClose={onClose}
        displayValue=""
        isLoading={false}
        canGoBack={false}
        canGoForward={false}
        onBack={noop}
        onForward={noop}
        onReload={noop}
        onHome={noop}
        onNavigate={noop}
        inputRef={addressRef}
        disabled
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function SearchHint() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-muted-foreground flex flex-col items-center gap-4 px-4 text-center">
        <Globe className="size-12 opacity-20" />
        <p className="text-sm">{tI18nComplete.raw('text2f883b75cd2d')}</p>
      </div>
    </div>
  );
}
