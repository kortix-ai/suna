'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Shared error card for in-app fallbacks (ClientErrorBoundary + route-segment
 * `error.tsx`). Mirrors the error surface of the top-level `global-error.tsx`:
 * the error name + message, with the stack tucked behind a collapsible
 * `<details>`. Uses theme tokens so it reads correctly in light and dark.
 */
export function ErrorDetails({ error }: { error: Error & { digest?: string } }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const message = error.message || 'An unexpected error occurred.';
  const stack = (error.stack || '').split('\n').slice(0, 6).join('\n').trim();

  return (
    <div className="border-border bg-muted/30 w-full max-w-md rounded-2xl border p-3 text-left">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground/70 text-[10px] font-semibold tracking-wider uppercase">
          {tI18nComplete.raw('text54a0e8c17ebb')}
        </span>
        <span className="text-muted-foreground/60 font-mono text-[10px]">
          {error.name || 'Error'}
          {error.digest ? ` · ${error.digest}` : ''}
        </span>
      </div>
      <div className="text-foreground/90 text-sm leading-snug wrap-break-word">{message}</div>
      {stack && (
        <details className="group mt-2">
          <summary className="text-muted-foreground/60 cursor-pointer text-[10px] tracking-wide uppercase outline-none select-none">
            {tI18nComplete.raw('texte551641242ce')}
          </summary>
          <pre className="border-border/60 bg-background/60 text-muted-foreground mt-1.5 max-h-36 overflow-auto rounded-2xl border p-2 font-mono text-[10px] leading-relaxed wrap-break-word whitespace-pre-wrap">
            {stack}
          </pre>
        </details>
      )}
    </div>
  );
}
