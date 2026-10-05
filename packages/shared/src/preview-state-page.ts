/**
 * What a PERSON sees for every state a preview can be in.
 *
 * A preview address is a real website address: people paste it, bookmark it,
 * open it in a fresh tab, and send it to each other. Every state it can be in
 * therefore needs a page — not JSON, and not an intermediary's error
 * interstitial. There are six, and they are all normal:
 *
 *   signed-out    no credential yet            → offer to sign in
 *   forbidden     host claimed without a signature
 *   unknown       no such sandbox any more
 *   starting      the box is waking             → wait, retry
 *   not-listening nothing bound to that port yet → wait, retry
 *   unreachable   the box is up but not answering
 *
 * ## Why the transient states answer 200
 *
 * "The dev server has not bound the port yet" is not a gateway failure — it is
 * the ordinary first few seconds of a preview. Reporting it as 502 was both
 * wrong and fragile: Cloudflare replaces an origin 5xx with its own branded
 * error page, so the careful page below never reached the browser at all (the
 * `x-kortix-proxy-hop` header was missing from what arrived, which is how we
 * know it was swapped, not passed through).
 *
 * So a browser navigation in a transient state gets 200 and this page, which
 * says what is happening and retries itself. The true state stays fully legible
 * to machines: the status, `x-kortix-proxy-hop` and `x-kortix-upstream-status`
 * are unchanged for every non-navigation request, and are still set on the HTML
 * response too, so a `fetch` probe can read them.
 *
 * The identity states keep their real status — 401, 403 and 404 are passed
 * through by every intermediary, and a crawler or monitor should see them.
 */

/** Escapes `& < > " '`, so the output is safe in element text and quoted
 *  attribute values. Same rules as the API's `shared/html.ts` escaper. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** States in which the app is still coming up: the sandbox is waking, or no
 *  process has bound the port yet. `unreachable` is NOT one: something was
 *  there and stopped answering, so it is not "building". The card shows its
 *  busy glyph only for these. */
export const PREVIEW_BUILDING_STATES: ReadonlySet<PreviewState> = new Set<PreviewState>([
  'starting',
  'not-listening',
]);

/**
 * Names the state on every response, HTML included, so a probe or a log can
 * attribute what happened without parsing a page.
 */
export const PREVIEW_STATE_HEADER = 'x-kortix-preview-state';

/** The `postMessage` type the page sends to the card that embeds it. */
export const PREVIEW_STATE_MESSAGE = 'kortix:preview-state';

/** Linear strip; the regex form backtracks on adversarial input. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return value.slice(0, end);
}

export type PreviewState =
  | 'signed-out'
  | 'forbidden'
  | 'unknown'
  | 'starting'
  | 'not-listening'
  | 'unreachable';

export interface PreviewStateCopy {
  title: string;
  body: string;
  /** Offer the Kortix sign-in hand-off. */
  signIn: boolean;
  /** Reload on a timer — only for states that resolve on their own. */
  autoRetry: boolean;
}

export function previewStateCopy(state: PreviewState, port?: number): PreviewStateCopy {
  switch (state) {
    case 'signed-out':
      return {
        title: 'Sign in to open this preview',
        body: 'This is a private preview of a Kortix sandbox. Sign in with the account that owns it and you will come straight back here.',
        signIn: true,
        autoRetry: false,
      };
    case 'forbidden':
      return {
        title: 'This preview address is not signed',
        body: 'The request reached Kortix without the edge signature that binds it to this hostname. Open the preview from your Kortix session.',
        signIn: true,
        autoRetry: false,
      };
    case 'unknown':
      return {
        title: 'This preview is no longer available',
        body: 'The sandbox behind this address does not exist any more. Sessions release their sandboxes when they are deleted.',
        signIn: false,
        autoRetry: false,
      };
    case 'starting':
      return {
        title: 'Starting the sandbox',
        body: 'The preview opens when it is ready.',
        signIn: false,
        autoRetry: true,
      };
    case 'not-listening':
      return {
        title: port ? `Waiting for port ${port}` : 'Waiting for the app',
        body: 'Nothing is running on this port yet. The preview opens when the app starts.',
        signIn: false,
        autoRetry: true,
      };
    case 'unreachable':
      return {
        title: port ? `Port ${port} is not answering` : 'The app is not answering',
        body: 'Start the app in your session if it stopped. This preview reconnects on its own.',
        signIn: false,
        autoRetry: true,
      };
  }
}

/**
 * The page. Self-contained (inline CSS and JS, no network), theme-aware, and
 * styled from the web app's tokens so it belongs beside the product rather than
 * looking like an error from somewhere else.
 */
export function previewStatePage(input: {
  state: PreviewState;
  port?: number;
  /** Where the person is trying to get to — shown, and carried into sign-in. */
  returnTo: string;
  /** The Kortix web app, for the sign-in hand-off. Empty disables the action. */
  frontendUrl?: string;
}): string {
  const copy = previewStateCopy(input.state, input.port);
  const base = stripTrailingSlashes(input.frontendUrl || '');
  const href = `${base}/preview/authorize?to=${encodeURIComponent(input.returnTo)}`;

  // The waiting states draw a load line on the top edge, like a browser tab
  // that is still loading. `unreachable` may never recover on its own, so it
  // draws no line and offers a quiet Try again instead (KRTX-1644).
  const loading = copy.autoRetry && input.state !== 'unreachable';

  // `target="_top"`: a preview is usually an iframe inside the session panel,
  // and a sign-in started INSIDE that frame would render the whole web app in a
  // preview pane. Break out to the tab instead.
  //
  // The card header already has refresh, so a waiting page carries no Retry
  // button: only `unreachable`, and a page that gave up, show a text-weight
  // Try again. The sandbox address is never printed: it is an internal host.
  const action =
    copy.signIn && base
      ? `<a class="btn" id="signin" href="${escapeHtml(href)}" target="_top" rel="noopener">Sign in to Kortix</a>`
      : copy.autoRetry
        ? `<button class="link" id="retry" type="button"${loading ? ' hidden' : ''}>Try again</button>`
        : '';

  // Reload quietly every 3 s, up to 40 times. No countdown: a line that
  // re-renders every second reads as noise on a page whose job is to wait.
  const retryScript = copy.autoRetry
    ? `
    (function () {
      var KEY = 'kortix-preview-retries';
      var MAX = 40, DELAY = 3000;
      var n = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0;
      var btn = document.getElementById('retry');
      var load = document.getElementById('load');
      if (btn) btn.addEventListener('click', function () {
        sessionStorage.setItem(KEY, '0'); location.reload();
      });
      if (n >= MAX) {
        if (load) load.hidden = true;
        if (btn) btn.hidden = false;
        var body = document.getElementById('body');
        if (body) body.textContent = 'This is taking longer than usual. Check the app in your session, then try again.';
        // The card drops its busy glyph: the page stopped waiting.
        try {
          if (window.parent !== window) {
            window.parent.postMessage({ type: '${PREVIEW_STATE_MESSAGE}', state: ${JSON.stringify(input.state)}, stalled: true }, '*');
          }
        } catch (e) {}
        return;
      }
      setTimeout(function () {
        sessionStorage.setItem(KEY, String(n + 1));
        location.reload();
      }, DELAY);
    })();`
    : '';

  // Tell the card that embeds this page which state it shows, so the card can
  // mark the preview as still starting instead of loaded. The payload is the
  // state name only; the receiver checks the frame it came from.
  const stateScript = `
    (function () {
      try {
        if (window.parent !== window) {
          window.parent.postMessage({ type: '${PREVIEW_STATE_MESSAGE}', state: ${JSON.stringify(input.state)} }, '*');
        }
      } catch (e) {}
    })();`;

  const signInScript = copy.signIn
    ? `
    (function () {
      var a = document.getElementById('signin');
      if (!a) return;
      try {
        var u = new URL(a.href);
        // The address the browser is ACTUALLY on, fragment included — the
        // server never sees that part.
        u.searchParams.set('to', window.location.href);
        a.href = u.toString();
      } catch (e) {}
    })();`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(copy.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --background: #ffffff;
    --foreground: #1f1f1f;
    --muted-foreground: #666666;
    --border: #e2e2e2;
    --ring: #0099ff;
    --ease: cubic-bezier(0.2, 0, 0, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: #0b0b0b;
      --foreground: #ffffff;
      --muted-foreground: #999999;
      --border: #262626;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; }
  body {
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--background); color: var(--foreground);
    -webkit-font-smoothing: antialiased;
  }
  .load { position: fixed; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; }
  .load::after {
    content: ""; position: absolute; inset: 0; width: 40%;
    background: var(--foreground); opacity: .55;
    animation: load 1.4s var(--ease) infinite;
  }
  @keyframes load { from { transform: translateX(-100%); } to { transform: translateX(260%); } }
  .page { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 28px; }
  h1 { font-size: 13px; font-weight: 500; margin: 0; text-wrap: balance; }
  p { font-size: 13px; color: var(--muted-foreground); margin: 0; max-width: 44ch; text-wrap: pretty; }
  .link {
    font: inherit; font-size: 12px; margin-top: 8px; padding: 0; border: 0; background: none; cursor: pointer;
    color: var(--foreground); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px;
  }
  .link:hover { text-decoration-color: currentColor; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 28px; padding: 0 12px; margin-top: 10px; border: 0; border-radius: 6px;
    font: inherit; font-size: 12px; font-weight: 500; text-decoration: none; cursor: pointer;
    background: var(--foreground); color: var(--background);
    transition: opacity .15s var(--ease);
  }
  .btn:hover { opacity: .9; }
  .link:focus-visible, .btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .load::after { animation: none; width: 100%; opacity: .2; } }
</style>
</head>
<body>
  ${loading ? '<div class="load" id="load" role="progressbar" aria-label="Loading preview"></div>' : ''}
  <main class="page">
    <h1>${escapeHtml(copy.title)}</h1>
    <p id="body">${escapeHtml(copy.body)}</p>
    ${action}
  </main>
  <script>${stateScript}${signInScript}${retryScript}</script>
</body>
</html>`;
}
