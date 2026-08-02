'use client';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Icon } from '@/features/icon/icon';
import { isRuntimeNotReadyNoiseMessage } from '@/lib/browser-error-noise';
import { cn } from '@/lib/utils';
import { CaretRightIcon, CheckIcon } from '@phosphor-icons/react';
import * as Sentry from '@sentry/nextjs';
import { useTranslations } from 'next-intl';
import type { ErrorInfo } from 'react';
import { Component, useCallback, useMemo, useState } from 'react';

// `children` is typed via the global `React.ReactNode` (not the named import)
// so it matches the layout's children type — the app pins @types/react@18 but
// the App Router layout children resolve React 19's ReactNode. Mirrors the
// pattern used by ReactQueryProvider.
export type ErrorBoundaryFallback = (props: { error: Error; reset: () => void }) => React.ReactNode;

/** Copy the whole error report in one click — the thing a user pastes into a bug report. */
function CopyErrorButton({ report, label }: { report: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(report).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => console.error('Failed to copy error details:', e),
    );
  }, [report]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10',
        'hit-area-3 inline-flex size-7 shrink-0 items-center justify-center rounded-sm',
        'focus-visible:ring-kortix-base cursor-pointer outline-none focus-visible:ring-[0.6px]',
      )}
    >
      {/* Fixed-size box so the check/copy swap never shifts the row. */}
      <span className="inline-flex size-3.5 items-center justify-center">
        {copied ? (
          <CheckIcon className="text-foreground size-3.5" />
        ) : (
          <Icon.Copy className="size-3.5" />
        )}
      </span>
    </button>
  );
}

/**
 * Default in-shell crash card. Deliberately reads like `app/not-found.tsx` and
 * `app/error.tsx`: a centered column, one headline, one line of body copy, then
 * the recovery actions. The technical payload (message, error name, digest,
 * stack frames) is folded into a collapsed `Disclosure` so the calm state stays
 * calm — a stack trace is never the first thing a user reads.
 */
function DefaultAppFallback({ error, reset }: { error: Error; reset: () => void }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);

  const digest = (error as Error & { digest?: string }).digest;
  const message = error.message?.trim() || 'An unexpected error occurred.';
  // The signature is the one piece of machine detail worth showing collapsed —
  // it is what an engineer asks for first ("which error, which build?").
  const signature = `${error.name || 'Error'}${digest ? ` · ${digest}` : ''}`;

  // V8 repeats "Name: message" as the stack's first line; keep only the frames
  // so the panel doesn't print the message twice. Fall back to raw lines for
  // engines that format differently.
  const frames = useMemo(() => {
    const lines = (error.stack ?? '').split('\n').map((l) => l.trim());
    const atFrames = lines.filter((l) => l.startsWith('at '));
    return (atFrames.length ? atFrames : lines.slice(1)).slice(0, 6).join('\n').trim();
  }, [error.stack]);

  const report = useMemo(
    () => [signature, message, frames].filter(Boolean).join('\n'),
    [signature, message, frames],
  );

  return (
    <div className="flex h-full min-h-[60vh] w-full flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-center gap-7">
        <div className="space-y-2 text-center">
          <h2 className="text-foreground text-lg font-semibold text-balance">
            {tI18nHardcoded.raw(
              'autoComponentsCommonErrorBoundaryJsxTextSomethingWentWrong1571085c',
            )}
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
            {tI18nHardcoded.raw('autoComponentsCommonErrorBoundaryJsxTextThisPartOfThe0af7a52e')}
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button onClick={reset} size="sm">
            {tI18nHardcoded.raw('autoComponentsCommonErrorBoundaryJsxTextTryAgain9615ff3f')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.reload();
            }}
          >
            {tI18nHardcoded.raw('componentsCommonErrorBoundary.reload')}
          </Button>
        </div>

        <div className="w-full">
          <Disclosure
            variant="outline"
            open={open}
            onOpenChange={setOpen}
            className="bg-popover w-full overflow-hidden text-left"
          >
            <DisclosureTrigger variant="outline">
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-full justify-between gap-3 rounded-none px-3 font-normal"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0 group-data-[state=open]:rotate-90" />
                  <span className="text-xs font-medium">
                    {tI18nHardcoded.raw('componentsCommonErrorBoundary.errorDetails')}
                  </span>
                </span>
                <span className="text-muted-foreground/70 truncate font-mono text-xs">
                  {signature}
                </span>
              </Button>
            </DisclosureTrigger>

            <DisclosureContent variant="outline" className="overflow-hidden">
              <div className="border-border space-y-2.5 border-t px-3 py-3">
                <div className="flex items-start gap-2">
                  <p className="text-foreground/90 min-w-0 flex-1 text-xs leading-relaxed wrap-break-word">
                    {message}
                  </p>
                  <CopyErrorButton
                    report={report}
                    label={tI18nHardcoded.raw('componentsCommonErrorBoundary.copyDetails')}
                  />
                </div>
                {frames ? (
                  <pre className="bg-muted/50 text-muted-foreground max-h-40 overflow-auto rounded-sm p-2 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
                    {frames}
                  </pre>
                ) : null}
              </div>
            </DisclosureContent>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}

interface InnerProps {
  children: React.ReactNode;
  render: ErrorBoundaryFallback;
}

interface State {
  error: Error | null;
}

class ErrorBoundaryInner extends Component<InnerProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Transient "session runtime not ready" is an expected, self-healing info
    // state (every session switch/provisioning window) — never an error. The
    // global `app/error.tsx` boundary already suppresses it for the route
    // segment; mirror that here so a subtree wrapped in this boundary doesn't
    // page Better Stack for the same transient throw. The Sentry `ignoreErrors`
    // list + `beforeSend` filter back this up at the SDK level.
    if (isRuntimeNotReadyNoiseMessage(error?.message)) {
      return;
    }
    Sentry.captureException(error, {
      extra: { componentStack: info.componentStack },
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    // Wrap in a fragment so children flow through JSX (lenient) rather than the
    // class render() return type (which would re-introduce the 18/19 mismatch).
    if (error) return <>{this.props.render({ error, reset: this.reset })}</>;
    return <>{this.props.children}</>;
  }
}

/**
 * Client error boundary. Contains a render crash to its subtree (showing a
 * fallback) instead of letting it escalate to Next's `global-error`, which
 * replaces the whole document and forces a full reload. Caught errors are
 * reported to Sentry. Pass a custom `fallback` for a local UI; omit it for the
 * default in-shell "something went wrong" card.
 */
export function ClientErrorBoundary({
  children,
  fallback,
  silent,
}: {
  children: React.ReactNode;
  fallback?: ErrorBoundaryFallback;
  /**
   * Render nothing on error (for non-critical widgets like analytics). Use this
   * instead of `fallback={() => null}` so a Server Component can use the
   * boundary — functions can't cross the server/client boundary, but a boolean
   * can. The null-rendering fallback is created here, inside the client module.
   */
  silent?: boolean;
}) {
  const render: ErrorBoundaryFallback =
    fallback ??
    (silent
      ? () => null
      : (props) => <DefaultAppFallback error={props.error} reset={props.reset} />);
  return <ErrorBoundaryInner render={render}>{children}</ErrorBoundaryInner>;
}
