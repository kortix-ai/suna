'use client';

import { Component } from 'react';
import type { ErrorInfo } from 'react';
import * as Sentry from '@sentry/nextjs';
import { Button } from '@/components/ui/button';

// `children` is typed via the global `React.ReactNode` (not the named import)
// so it matches the layout's children type — the app pins @types/react@18 but
// the App Router layout children resolve React 19's ReactNode. Mirrors the
// pattern used by ReactQueryProvider.
export type ErrorBoundaryFallback = (props: { error: Error; reset: () => void }) => React.ReactNode;

function DefaultAppFallback({ reset }: { reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="space-y-1.5">
        <h2 className="text-lg font-medium text-foreground">Something went wrong</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          This part of the app hit an unexpected error. Try again, or reload the page if it keeps happening.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
        <Button
          onClick={() => {
            if (typeof window !== 'undefined') window.location.reload();
          }}
        >
          Reload
        </Button>
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
    fallback ?? (silent ? () => null : (props) => <DefaultAppFallback reset={props.reset} />);
  return <ErrorBoundaryInner render={render}>{children}</ErrorBoundaryInner>;
}
