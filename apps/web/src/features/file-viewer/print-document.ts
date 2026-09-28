/**
 * Print a standalone HTML fragment instead of the app — the browser half of
 * "Save as PDF" for markdown files (`markdown-pdf.ts` builds the HTML).
 *
 * Why the main window and not a hidden iframe: the print dialog names the PDF
 * after the TOP document's title, and the header/footer print the top
 * document's URL — an iframe gives `about:srcdoc`. Printing the main window is
 * also the path Cmd+P on a session already takes (`use-session-print.ts`), so
 * it behaves the same in the Electron shell, which loads this app.
 *
 * The fragment is mounted as the last child of `<body>`. While a print is
 * active, `html` carries `data-print-document-active` and `app/print.css` hides
 * every other child of `<body>` — the app root, the file-viewer portal,
 * toasts — so the printed page is the document alone, in the paper palette
 * that file already pins.
 */

export const PRINT_DOCUMENT_ATTR = 'data-print-document';
export const PRINT_DOCUMENT_ACTIVE_ATTR = 'data-print-document-active';

/** Leak guard for a dialog dismissed without `afterprint`; see `use-session-print.ts`. */
const CLEANUP_FALLBACK_MS = 10 * 60_000;

/** A remote image that has not loaded by now prints as its broken box. */
const IMAGE_WAIT_MS = 10_000;

let printing = false;

function imagesSettled(root: HTMLElement): Promise<unknown> {
  const pending = Array.from(root.querySelectorAll('img'))
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    );
  if (pending.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS)),
  ]);
}

/**
 * Mount `html`, wait for its images and fonts, then open the print dialog with
 * the page titled `title` (the saved PDF's default file name).
 *
 * `onReady` runs immediately before `window.print()`. Chrome blocks inside that
 * call until the dialog closes, so a caller's pending state must be dropped
 * there, not after this resolves.
 *
 * Returns false without printing when another print is already open.
 */
export async function printHtmlDocument(
  html: string,
  title: string,
  onReady?: () => void,
): Promise<boolean> {
  if (printing) return false;
  printing = true;

  const root = document.createElement('div');
  root.setAttribute(PRINT_DOCUMENT_ATTR, '');
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = html;
  document.body.appendChild(root);

  const previousTitle = document.title;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  // Armed before the print and never run right after it: Safari returns from
  // `window.print()` immediately and would lose the document mid-compose.
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(fallback);
    window.removeEventListener('afterprint', cleanup);
    document.documentElement.removeAttribute(PRINT_DOCUMENT_ACTIVE_ATTR);
    document.title = previousTitle;
    root.remove();
    printing = false;
  };

  try {
    await imagesSettled(root);
    await document.fonts?.ready;
    document.documentElement.setAttribute(PRINT_DOCUMENT_ACTIVE_ATTR, '');
    document.title = title;
    onReady?.();
    fallback = setTimeout(cleanup, CLEANUP_FALLBACK_MS);
    window.addEventListener('afterprint', cleanup);
    window.print();
    return true;
  } catch (error) {
    cleanup();
    throw error;
  }
}
