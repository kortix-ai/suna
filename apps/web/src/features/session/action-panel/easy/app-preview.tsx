'use client';

/**
 * `AppPreview` — the running thing, opened.
 *
 * When someone asks for a landing page, a dashboard, a React app, the
 * deliverable isn't a file on disk — it's a server on a port. Easy mode has no
 * tab strip, so before this there was no way to reach it at all: the one output
 * the user actually wanted was the one they couldn't get to.
 *
 * This is `BrowserPanel`'s chrome — back / forward / refresh / address bar,
 * loading overlay, and the "port may not be running yet" retry — inside the
 * detail layer. It is a port rather than a reuse because `BrowserPanel` is
 * driven by a `tabId` and writes into the tab store: mounting it here would
 * spawn a tab in the app's tab bar as a side effect of opening an output.
 *
 * The address bar controls the sandbox's own PORTS, not the open web — the same
 * rule `BrowserPanel` enforces, and for the same reason: this is a window onto
 * your sandbox, not a browser.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useCopy } from '@/hooks/use-copy';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { useIsMobile } from '@/hooks/utils';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { parseLocalhostUrl, toInternalUrl } from '@/lib/utils/sandbox-url';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import { useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Link as LinkIcon,
  Maximize2,
  Minimize2,
  RefreshCw,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GrRefresh } from 'react-icons/gr';
import { TbExternalLink } from 'react-icons/tb';
import { CloseButton } from './detail-view';

// zustand v5's own hook feeds React's `useSyncExternalStore` a
// `getServerSnapshot` pinned to `getInitialState()` — correct for real SSR
// (sandbox health can only ever be learned from a client-side poll, so it is
// genuinely "connecting" at request time), but it means a real server-render
// dispatcher can never observe a `setState` call that happened earlier in the
// same process, as this component's render tests need to. Reading through
// `getState()` for both snapshots sidesteps that — same live value, same
// reactivity via `subscribe`, no behavior change in the browser or real SSR.
const getSandboxAliveSnapshot = () => {
  const s = useSandboxConnectionStore.getState();
  return s.status === 'connected' && s.healthy === true;
};

/** Split a URL so the hostname can be rendered brighter than the rest. */
function splitUrlForDisplay(url: string): { prefix: string; host: string; rest: string } | null {
  try {
    const host = new URL(url).host;
    const idx = url.indexOf(host);
    if (!host || idx === -1) return null;
    return { prefix: url.slice(0, idx), host, rest: url.slice(idx + host.length) };
  } catch {
    return null;
  }
}

export function AppPreview({
  url,
  name,
  onClose,
}: {
  /** The internal sandbox URL the agent handed over, e.g. http://localhost:3000. */
  url: string;
  name: string;
  onClose: () => void;
}) {
  // The app runs on localhost *inside the sandbox*, which the browser cannot
  // reach. The proxy is what makes it openable at all.
  const { proxyUrl } = useSandboxProxy();

  // History of internal (localhost) URLs. Back/forward are real, not decorative.
  const [history, setHistory] = useState<string[]>([url]);
  const [index, setIndex] = useState(0);
  const current = history[index] ?? url;
  const port = useMemo(() => parseLocalhostUrl(current)?.port ?? 0, [current]);

  const proxied = useMemo(() => proxyUrl(current) ?? current, [proxyUrl, current]);
  // Null while the auth token is still being fetched — the landing state holds.
  const previewUrl = useAuthenticatedPreviewUrl(proxied);

  const [refreshKey, setRefreshKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const loadTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [addressValue, setAddressValue] = useState(current);
  const [isEditing, setIsEditing] = useState(false);
  const [addressError, setAddressError] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);

  const isExpanded = useIsExpanded();
  const toggleExpanded = useToggleExpanded();
  const isMobile = useIsMobile();
  const { copied, copy } = useCopy({ successMessage: 'Link copied' });

  const sandboxAlive = useSyncExternalStore(
    useSandboxConnectionStore.subscribe,
    getSandboxAliveSnapshot,
    getSandboxAliveSnapshot,
  );

  useEffect(() => {
    if (!isEditing) setAddressValue(current);
  }, [current, isEditing]);

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeout.current) {
      clearTimeout(loadTimeout.current);
      loadTimeout.current = null;
    }
  }, []);

  // Cross-origin iframes frequently never fire onLoad OR onError, so both the
  // spinner and the error card would otherwise hang on a dead server. After 5s
  // of silence, assume the worst and say so — a blank frame reads as "your app
  // is broken" with no explanation, which is worse than an honest error (W8).
  useEffect(() => {
    if (!isLoading) return;
    clearLoadTimeout();
    loadTimeout.current = setTimeout(() => {
      setIsLoading(false);
      setHasError(true);
    }, 5000);
    return clearLoadTimeout;
  }, [isLoading, refreshKey, clearLoadTimeout]);

  const reload = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const navigateTo = useCallback(
    (next: string) => {
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

  /**
   * Sandbox ports only. A bare port, `:port`, `localhost:port`, `127.0.0.1:port`
   * or a full localhost URL — each optionally with a path. Anything else (say,
   * `google.com`) is rejected inline rather than silently attempting to browse it.
   */
  const handleAddressSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      let value = addressValue.trim();
      if (!value) return;

      if (/^\d{1,5}(?:[/?#]|$)/.test(value)) value = `http://localhost:${value}`;
      else if (/^:\d{1,5}/.test(value)) value = `http://localhost${value}`;
      else if (/^(?:localhost|127\.0\.0\.1):\d+/i.test(value)) value = `http://${value}`;

      const parsed = parseLocalhostUrl(value);
      if (!parsed) {
        setAddressError(true);
        return;
      }

      setAddressError(false);
      setIsEditing(false);
      navigateTo(toInternalUrl(parsed.port, parsed.path));
    },
    [addressValue, navigateTo],
  );

  const hasPreview = !!previewUrl;

  // At rest the bar shows the full URL; this overlay re-renders it with the
  // hostname highlighted, which an <input> can't do (it can't mix text colors).
  const urlParts = useMemo(
    () => (isEditing || addressError || !hasPreview ? null : splitUrlForDisplay(current)),
    [isEditing, addressError, hasPreview, current],
  );

  return (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      <div className="border-border flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
        <Hint label="Back" side="bottom">
          <Button variant="ghost" size="icon" onClick={goBack} disabled={!hasPreview || !canGoBack}>
            <ArrowLeft className="size-4" />
          </Button>
        </Hint>

        <Hint label="Forward" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            onClick={goForward}
            disabled={!hasPreview || !canGoForward}
          >
            <ArrowRight className="size-4" />
          </Button>
        </Hint>

        <Hint label="Refresh" side="bottom">
          <Button variant="ghost" size="icon" onClick={reload} disabled={!hasPreview}>
            <GrRefresh className={cn('size-4', isLoading && 'animate-spinner-spin')} />
          </Button>
        </Hint>

        <form onSubmit={handleAddressSubmit} className="flex min-w-0 flex-1 items-center px-1">
          <div
            className={cn(
              'group/address hover:bg-input focus-within:bg-input focus-within:border-border relative flex h-7 w-full items-center rounded-sm border border-transparent bg-transparent px-3 text-xs tracking-tight transition-colors',
              addressError &&
                'border-kortix-red/60 focus-within:border-kortix-red/60 animate-shake',
            )}
          >
            <Input
              ref={addressRef}
              type="text"
              size="xs"
              value={addressValue}
              onChange={(e) => {
                setAddressValue(e.target.value);
                if (addressError) setAddressError(false);
              }}
              onFocus={() => {
                setIsEditing(true);
                setTimeout(() => addressRef.current?.select(), 0);
              }}
              onBlur={() => setIsEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setIsEditing(false);
                  setAddressError(false);
                  setAddressValue(current);
                  addressRef.current?.blur();
                }
              }}
              placeholder="Type a port, e.g. 3000"
              className={cn(
                'h-full min-w-0 flex-1 truncate rounded-none border-none bg-transparent px-0 font-medium focus:border-none',
                urlParts && 'text-transparent',
              )}
            />
            {urlParts && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-3.5 left-3.5 flex items-center overflow-hidden whitespace-nowrap"
              >
                <span className="text-muted-foreground group-hover/address:text-foreground truncate transition-colors">
                  {urlParts.prefix}
                  <span className="text-foreground">{urlParts.host}</span>
                  {urlParts.rest}
                </span>
              </span>
            )}
            {addressError && (
              <span className="text-kortix-red ml-2 shrink-0 text-xs">Sandbox ports only</span>
            )}
          </div>
        </form>

        <Hint label="Open in a new tab" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            disabled={!hasPreview}
            aria-label="Open in a new tab"
            onClick={() => previewUrl && window.open(previewUrl, '_blank', 'noopener,noreferrer')}
          >
            <TbExternalLink className="size-4" />
          </Button>
        </Hint>

        <Hint label={copied ? 'Copied' : 'Copy link'} side="bottom">
          <Button
            variant="ghost"
            size="icon"
            disabled={!hasPreview}
            aria-label="Copy link"
            onClick={() => previewUrl && copy(previewUrl)}
          >
            {/* Morph, not a hard swap — same box, cross-faded (kortix-design-system
                → "Button icon-swap"). */}
            <span className="relative inline-flex size-4 items-center justify-center">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={copied ? 'check' : 'link'}
                  initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                  exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="absolute inset-0 inline-flex items-center justify-center"
                >
                  {copied ? (
                    <Check className="text-kortix-green size-4" />
                  ) : (
                    <LinkIcon className="size-4" />
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          </Button>
        </Hint>

        {/* The store flip is a no-op on mobile — the drawer never reads
            `isExpanded` — so the control was dead weight there. */}
        {!isMobile && (
          <Hint label={isExpanded ? 'Exit full screen' : 'Full screen'} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleExpanded}
              aria-label={isExpanded ? 'Exit full screen' : 'Full screen'}
            >
              {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
          </Hint>
        )}

        <CloseButton onClose={onClose} />
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {isLoading && hasPreview && (
          <div className="bg-background/80 absolute inset-0 z-10 flex items-center justify-center">
            <div className="text-muted-foreground flex flex-col items-center gap-2">
              <Loading className="size-4" />
              <p className="text-xs">Loading preview…</p>
            </div>
          </div>
        )}

        {hasError && (
          <div className="bg-background absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex max-w-sm flex-col items-center gap-4 px-4 text-center">
              <span className="bg-kortix-orange/15 flex size-9 items-center justify-center rounded-sm">
                <AlertTriangle className="text-kortix-orange size-5" />
              </span>
              <div>
                <p className="text-sm font-medium">Couldn&apos;t load {name}</p>
                {/* The single most common cause, said plainly: the agent started
                    the server a moment ago and it isn't listening yet. */}
                <p className="text-muted-foreground mt-1 text-xs">
                  {!sandboxAlive
                    ? 'This workspace has stopped, so the app isn’t reachable anymore.'
                    : port
                      ? `The app on port ${port} may not be running yet.`
                      : 'The app may not be running yet.'}
                </p>
              </div>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={reload}>
                <RefreshCw className="size-3.5 shrink-0" />
                Retry
              </Button>
            </div>
          </div>
        )}

        {hasPreview ? (
          <iframe
            key={refreshKey}
            src={previewUrl}
            title={name}
            className="h-full w-full border-0"
            sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
            onLoad={() => {
              clearLoadTimeout();
              setIsLoading(false);
            }}
            onError={() => {
              clearLoadTimeout();
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
