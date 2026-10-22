'use client';

/**
 * The sandbox-browser chrome shared by the two preview surfaces —
 * `BrowserPanel` (the tab strip's browser tab) and the detail layer's
 * `AppPreview` (easy mode's running-app view).
 *
 * Both render the same back / forward / reload toolbar and the same address
 * bar. The copies drifted apart before (different i18n accessors, different
 * handler names), so a fix to one toolbar silently missed the other; this
 * module owns the chrome once. The address bar controls the sandbox's own
 * PORTS, not the open web — this is a window onto your sandbox, not a
 * browser.
 *
 * What the two surfaces keep for themselves is the model around the chrome:
 * `BrowserPanel` is driven by a `tabId` and writes into the tab store (it
 * also opens external web URLs through the web proxy), while `AppPreview`
 * keeps a tab-store-free history and its own port-watch probe loop — easy
 * mode has no tab strip, so mounting `BrowserPanel` there would spawn a tab
 * in the app's tab bar as a side effect of opening an output. Both hand this
 * module the current address, the nav state and an `onNavigate` callback.
 */

import { Button } from '../primitives/button';
import { ButtonGroup } from '../primitives/button-group';
import Hint from '../primitives/hint';
import { Input } from '../primitives/input';
import { Home } from '../internal/icons/home';
import { isKortixAppUrl } from '../apps/kortix-app-url';
import Loading from '../primitives/loading';
import { useTranslations } from '../i18n';
import { cn } from '../lib/utils';
import { parseLocalhostUrl, toInternalUrl } from '@kortix/sdk';
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  ArrowClockwiseIcon as GrRefresh,
} from '@phosphor-icons/react';
import type { FormEvent, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

/** Split a URL so the hostname can be rendered brighter than the rest. */
export function splitUrlForDisplay(
  url: string,
): { prefix: string; host: string; rest: string } | null {
  try {
    const host = new URL(url).host;
    const idx = url.indexOf(host);
    if (!host || idx === -1) return null;
    return { prefix: url.slice(0, idx), host, rest: url.slice(idx + host.length) };
  } catch {
    return null;
  }
}

/**
 * Normalize an address-bar draft into the internal localhost URL it names.
 *
 * This bar controls the sandbox's local PORTS and Kortix Apps only — not
 * arbitrary external sites — so we accept a bare port, `:port`,
 * `localhost:port`, `127.0.0.1:port`, or a full localhost URL (each optionally
 * followed by a path), and a Kortix App URL with or without its scheme.
 * Anything else (e.g. `google.com`) is rejected inline rather than attempting
 * to browse it.
 *
 * Returns `http://localhost:<port><path>` or the App URL, or null when the
 * input is empty or names neither.
 */
export function parseAddressInput(value: string): string | null {
  let url = value.trim();
  if (!url) return null;

  const scheme = /\.apps\.localhost(?::\d+)?(?:[/?#]|$)/i.test(url) ? 'http' : 'https';
  const appUrl = /^https?:\/\//i.test(url) ? url : `${scheme}://${url}`;
  if (isKortixAppUrl(appUrl)) return appUrl;

  if (/^\d{1,5}(?:[/?#]|$)/.test(url)) {
    url = `http://localhost:${url}`;
  } else if (/^:\d{1,5}/.test(url)) {
    url = `http://localhost${url}`;
  } else if (/^(?:localhost|127\.0\.0\.1):\d+/i.test(url)) {
    url = `http://${url}`;
  }

  const parsed = parseLocalhostUrl(url);
  if (!parsed) return null;
  return toInternalUrl(parsed.port, parsed.path);
}

/**
 * The back / forward buttons and the home / address / reload group every
 * sandbox preview surface renders, with the hostname highlighted at rest. The bar
 * owns its own draft state; the surface keeps its history model and hands in
 * the current address via `displayValue`. The surface composes its own row
 * controls around it (`BrowserPanel`'s overflow menu, `AppPreview`'s viewer
 * actions and close) — the component is a fragment, so it slots between them.
 */
export function SandboxAddressBar({
  displayValue,
  hasPreview,
  isLoading,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onReload,
  onHome,
  onNavigate,
  suggestions = [],
  placeholder,
  ariaLabel,
  inputRef,
  resetOnEscape = true,
  trailing,
}: {
  /** The URL the bar shows at rest — the surface's current address. */
  displayValue: string;
  hasPreview: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  /** Back to the browser's landing (the project's Apps and recents). */
  onHome: () => void;
  /** Called with the internal `http://localhost:<port><path>` URL or a Kortix
   *  App URL, after the draft parses as one, or names a `suggestions` entry. */
  onNavigate: (internalUrl: string) => void;
  /** Named destinations the bar completes (the project's Apps). Typing a
   *  label opens its URL. */
  suggestions?: readonly { label: string; url: string }[];
  placeholder: string;
  ariaLabel?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Escape restores `displayValue`. `BrowserPanel` only restores with a live
   *  preview — its landing tab keeps the user's draft — so it passes
   *  `hasPreview` here; `AppPreview` always restores. */
  resetOnEscape?: boolean;
  /** Actions on the open page, rendered at the address's trailing edge —
   *  `AppPreview` puts `Copy link` here. */
  trailing?: ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [addressValue, setAddressValue] = useState(displayValue);
  const [isEditing, setIsEditing] = useState(false);
  // Set when the address bar gets something that isn't a sandbox port, so we
  // can flag it inline instead of attempting to browse it.
  const [addressError, setAddressError] = useState(false);

  // Sync the draft when the surface's address changes externally — tab
  // metadata for `BrowserPanel`, a navigation inside `AppPreview`.
  useEffect(() => {
    if (!isEditing) setAddressValue(displayValue);
  }, [displayValue, isEditing]);

  // At rest the bar always shows the full URL; the overlay below re-renders it
  // with the hostname highlighted (an input can't mix text colors).
  const urlParts = useMemo(
    () => (isEditing || addressError || !hasPreview ? null : splitUrlForDisplay(displayValue)),
    [isEditing, addressError, hasPreview, displayValue],
  );

  const handleAddressSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!addressValue.trim()) return;

      const wanted = addressValue.trim().toLowerCase();
      const internal =
        suggestions.find((entry) => entry.label.toLowerCase() === wanted)?.url ??
        parseAddressInput(addressValue);
      if (!internal) {
        setAddressError(true);
        return;
      }

      setAddressError(false);
      setIsEditing(false);
      onNavigate(internal);
    },
    [addressValue, onNavigate, suggestions],
  );
  const suggestionsId = useId();

  return (
    <>
      <ButtonGroup className="shrink-0">
        <Hint label={tI18nComplete.raw('text76900f1bfd16')} side="bottom">
          <Button
            variant="secondary"
            size="icon"
            onClick={onBack}
            disabled={!hasPreview || !canGoBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
        </Hint>

        <Hint label={tI18nComplete.raw('textf1c65e14817e')} side="bottom">
          <Button
            variant="secondary"
            size="icon"
            onClick={onForward}
            disabled={!hasPreview || !canGoForward}
          >
            <ArrowRight className="size-4" />
          </Button>
        </Hint>
      </ButtonGroup>

      {/* Home, the address, Reload: one group, built like Back / Forward. The
          page's own actions (`trailing`) sit at the address's trailing edge. */}
      <form onSubmit={handleAddressSubmit} className="flex min-w-0 flex-1 items-center px-1">
        <ButtonGroup className="w-full min-w-0">
          <Hint label={tI18nComplete.raw('text3a78695388b3')} side="bottom">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={onHome}
              disabled={!hasPreview}
              aria-label={tI18nComplete.raw('text3a78695388b3')}
            >
              <Home className="size-3.5" />
            </Button>
          </Hint>
          <div
            className={cn(
              'bg-muted flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-transparent px-2 text-xs tracking-tight transition-colors',
              addressError && 'border-kortix-red/60 focus-within:border-kortix-red/60 animate-shake',
            )}
          >
            <div className="group/address relative flex h-full min-w-0 flex-1 items-center">
              <Input
                ref={inputRef}
                type="text"
                size="xs"
                value={urlParts ? displayValue : addressValue}
                aria-label={ariaLabel}
                list={suggestions.length ? suggestionsId : undefined}
                onChange={(e) => {
                  setAddressValue(e.target.value);
                  if (addressError) setAddressError(false);
                }}
                onFocus={() => {
                  setIsEditing(true);
                  setTimeout(() => inputRef.current?.select(), 0);
                }}
                onBlur={() => setIsEditing(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setIsEditing(false);
                    setAddressError(false);
                    if (resetOnEscape) setAddressValue(displayValue);
                    inputRef.current?.blur();
                  }
                }}
                placeholder={placeholder}
                className={cn(
                  // The `<datalist>` suggestions must not paint Chrome's dropdown arrow.
                  'h-full min-w-0 flex-1 truncate rounded-none border-none bg-transparent px-0 font-medium focus:border-none focus:ring-0 [&::-webkit-calendar-picker-indicator]:hidden',
                  urlParts && 'text-transparent',
                )}
              />
              {urlParts && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-0 left-0 flex items-center overflow-hidden whitespace-nowrap"
                >
                  <span className="text-muted-foreground group-hover/address:text-foreground truncate transition-colors">
                    {urlParts.prefix}
                    <span className="text-foreground">{urlParts.host}</span>
                    {urlParts.rest}
                  </span>
                </span>
              )}
            </div>
            {suggestions.length ? (
              <datalist id={suggestionsId}>
                {suggestions.map((entry) => (
                  <option key={entry.url} value={entry.label} />
                ))}
              </datalist>
            ) : null}
            {addressError && (
              <span className="text-kortix-red shrink-0 text-xs">
                {tI18nComplete.raw('textce1e609b7bf5')}
              </span>
            )}
            {trailing}
          </div>
          <Hint label={tI18nComplete.raw('text0e9161011702')} side="bottom">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={onReload}
              disabled={!hasPreview}
              aria-label={tI18nComplete.raw('text0e9161011702')}
            >
              <GrRefresh className={cn('size-4', isLoading && 'animate-spinner-spin')} />
            </Button>
          </Hint>
        </ButtonGroup>
      </form>
    </>
  );
}

/**
 * The "still loading" overlay both preview surfaces paint over the iframe.
 * Cross-origin iframes frequently never fire onLoad, so neither surface may
 * trust the event alone — the parent decides when to show and dismiss this.
 */
export function PreviewLoadingOverlay({
  label,
  detail,
  action,
}: {
  label: string;
  /** A second line once the load is slow: why, and the way out. */
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-background/80 absolute inset-0 z-10 flex items-center justify-center">
      <div className="text-muted-foreground flex max-w-xs flex-col items-center gap-2 px-4 text-center">
        <Loading className="size-4" />
        <p className="text-xs">{label}</p>
        {detail && <p className="text-xs text-pretty">{detail}</p>}
        {action}
      </div>
    </div>
  );
}
