'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { FilePdfIcon } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { markdownPdfBlocker, pdfDocumentTitle, renderMarkdownForPrint } from './markdown-pdf';
import { printHtmlDocument } from './print-document';

/** Resolves after the next paint, so a spinner set just before is on screen. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * "Save as PDF" for a markdown file: renders the document the preview shows
 * and opens the print dialog on it, titled so the PDF saves as
 * `<basename>.pdf`.
 *
 * A sibling of Download, never a menu item behind it: Download stays the
 * one-click raw `.md` (see `viewer-download-button.tsx` for why Download is
 * never in a menu), and this is the one-click PDF.
 *
 * Disabled while the content is empty or not loaded yet. Past
 * `MARKDOWN_PDF_MAX_CHARS` it stays enabled and says why it will not export,
 * so the limit is discoverable instead of looking like a dead button.
 */
export function SaveAsPdfButton({
  fileName,
  content,
  className,
  iconClassName,
}: {
  fileName: string;
  /** The file's text. `undefined` while it loads. */
  content: string | undefined;
  className?: string;
  iconClassName?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = tI18nComplete.raw('text4cab70e9226b');
  const { proxyUrl } = useSandboxProxy();
  const [pending, setPending] = useState(false);
  const blocker = markdownPdfBlocker(content);

  const run = useCallback(async () => {
    if (pending || content === undefined) return;
    if (blocker === 'too-large') {
      errorToast(tI18nComplete.raw('textce87352f1102'));
      return;
    }
    setPending(true);
    try {
      // The parse is synchronous work on the main thread; let the spinner
      // paint first.
      await afterPaint();
      const html = await renderMarkdownForPrint(content, { resolveImageSrc: proxyUrl });
      await printHtmlDocument(html, pdfDocumentTitle(fileName), () =>
        flushSync(() => setPending(false)),
      );
    } catch {
      errorToast(tI18nComplete.raw('text3b0c86f182b0'));
    } finally {
      setPending(false);
    }
  }, [pending, content, blocker, proxyUrl, fileName, tI18nComplete]);

  return (
    <Hint label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-busy={pending}
        disabled={blocker === 'empty' || pending}
        onClick={() => void run()}
        data-save-as-pdf=""
        className={cn(
          'shrink-0 active:scale-[0.96]',
          // A spinning button is busy, not unavailable — keep it at full ink.
          pending && 'disabled:opacity-100',
          className,
        )}
      >
        {pending ? (
          <Loading
            className={cn('text-muted-foreground shrink-0 motion-reduce:animate-none', iconClassName)}
          />
        ) : (
          <FilePdfIcon className={iconClassName} />
        )}
      </Button>
    </Hint>
  );
}
