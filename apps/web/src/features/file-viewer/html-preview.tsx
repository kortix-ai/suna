'use client';

/**
 * `HtmlPreview` — an HTML file, shown the only way an HTML file can be shown.
 *
 * A page is not its markup. It is that markup plus everything the markup points
 * at — `./styles.css`, `img/hero.png`, `app.js` — and every one of those is a
 * URL resolved against the document's own. Handing the text to an iframe as
 * `srcDoc` gives the document NO url (`about:srcdoc`, opaque origin), so none of
 * those references can resolve and the page arrives as unstyled text. There is
 * no attribute that fixes that; the file has to be served.
 *
 * The sandbox already ships the server that does it — the static file server on
 * port 3211. `useStaticFilePreview` owns reaching it (the proxied URL, the
 * preview session, and the wait while a sandbox boots); this component owns the
 * three things a user sees while that happens.
 *
 * Used by every surface that previews an HTML file, so the Easy panel and the
 * files viewer cannot drift into two different answers about what an HTML file
 * looks like.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { ErrorState } from '@/features/layout/section/error-state';
import { ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { useStaticFilePreview } from '@kortix/sdk/react';
import { WarningIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * The frame fills its region edge to edge, and paints WHITE behind the
 * document — not `bg-background`.
 *
 * An iframe whose document sets no background of its own is transparent, so the
 * app's surface shows through it. In dark mode that puts an agent's black body
 * text on a near-black sheet and the page reads as blank. White is also simply
 * what a browser would show for the same file, which is the whole promise of a
 * preview. Same reasoning, same value as `SHARE_FILE_IFRAME_CLASS`, which
 * carries the identical note — a page that DOES set a background still paints
 * its own over this.
 */
export const HTML_PREVIEW_IFRAME_CLASS = 'block h-full w-full border-0 bg-white';

export function HtmlPreview({
  path,
  fileName,
  className,
  pendingLabel = 'Starting preview server…',
}: {
  /** Sandbox path of the file to serve. */
  path: string;
  /** Frame title — what a screen reader announces for the embedded document. */
  fileName: string;
  className?: string;
  /** Overridable so a surface that HAS a translation for this string can keep
   *  it. The default is the English copy, which is what the untranslated
   *  session panel would show anyway. */
  pendingLabel?: ReactNode;
}) {
  const { url, status, retry } = useStaticFilePreview(path);

  // Never a dead end: the server may simply be slower than the bound, and the
  // sandbox may have been asleep. One button is the whole recovery.
  if (status === 'unavailable') {
    return (
      <ErrorState
        icon={WarningIcon}
        size="sm"
        className={cn('h-full', className)}
        title="Couldn't reach the preview server"
        description="The sandbox may still be starting up."
        action={
          <Button variant="outline" size="sm" className="gap-1.5" onClick={retry}>
            Retry
          </Button>
        }
      />
    );
  }

  // `url` is null until the probe passes AND the preview session exists, so
  // this covers both waits with one state. An empty frame would read as "your
  // page is broken"; a spinner reads as "not yet".
  if (!url) {
    return (
      <div
        className={cn(
          'text-muted-foreground flex h-full flex-col items-center justify-center gap-2',
          className,
        )}
      >
        <Loading className="size-4" />
        <p className="text-xs">{pendingLabel}</p>
      </div>
    );
  }

  return (
    // `ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX` — scripts, forms, popups and
    // downloads run; `allow-same-origin` is withheld. An agent wrote this page,
    // so it gets a real browser to run in and an opaque origin to run it from:
    // it cannot read this app's DOM, cookies or storage. Withholding
    // `allow-scripts` instead would make every interactive page a screenshot.
    <iframe
      key={path}
      src={url}
      title={fileName}
      className={cn(HTML_PREVIEW_IFRAME_CLASS, className)}
      sandbox={ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX}
    />
  );
}
