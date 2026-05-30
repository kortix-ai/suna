'use client';

/**
 * Shared error card for in-app fallbacks (ClientErrorBoundary + route-segment
 * `error.tsx`). Mirrors the error surface of the top-level `global-error.tsx`:
 * the error name + message, with the stack tucked behind a collapsible
 * `<details>`. Uses theme tokens so it reads correctly in light and dark.
 */
export function ErrorDetails({ error }: { error: Error & { digest?: string } }) {
  const message = error.message || 'An unexpected error occurred.';
  const stack = (error.stack || '').split('\n').slice(0, 6).join('\n').trim();

  return (
    <div className="w-full max-w-md rounded-xl border border-border bg-muted/30 p-3 text-left">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Error
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {error.name || 'Error'}
          {error.digest ? ` · ${error.digest}` : ''}
        </span>
      </div>
      <div className="break-words text-sm leading-snug text-foreground/90">{message}</div>
      {stack && (
        <details className="group mt-2">
          <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wide text-muted-foreground/60 outline-none">
            Stack
          </summary>
          <pre className="mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {stack}
          </pre>
        </details>
      )}
    </div>
  );
}
