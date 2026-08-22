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

/**
 * Names the state on every response, HTML included, so a probe or a log can
 * attribute what happened without parsing a page.
 */
export const PREVIEW_STATE_HEADER = 'x-kortix-preview-state';

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
        body: 'The machine behind this preview is waking up. This page will load it as soon as it answers.',
        signIn: false,
        autoRetry: true,
      };
    case 'not-listening':
      return {
        title: port ? `Nothing is listening on port ${port} yet` : 'Nothing is listening yet',
        body: 'The sandbox is running, but no process has bound this port. Start the app in your session — this page will pick it up on its own.',
        signIn: false,
        autoRetry: true,
      };
    case 'unreachable':
      return {
        title: port ? `Port ${port} isn't responding` : 'This preview is not responding',
        body: 'The sandbox is up but the app did not answer. It may still be compiling, or it may have exited.',
        signIn: false,
        autoRetry: true,
      };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;'
    : ch === '<' ? '&lt;'
    : ch === '>' ? '&gt;'
    : ch === '"' ? '&quot;'
    : '&#39;');
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

  // `target="_top"`: a preview is usually an iframe inside the session panel,
  // and a sign-in started INSIDE that frame would render the whole web app in a
  // preview pane. Break out to the tab instead.
  const action =
    copy.signIn && base
      ? `<a class="btn" id="signin" href="${escapeHtml(href)}" target="_top" rel="noopener">Sign in to Kortix</a>`
      : copy.autoRetry
        ? `<button class="btn" id="retry" type="button">Retry now</button>`
        : '';

  const retryScript = copy.autoRetry
    ? `
    (function () {
      var KEY = 'kortix-preview-retries';
      var MAX = 40, DELAY = 3000;
      var n = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0;
      var status = document.getElementById('status');
      var btn = document.getElementById('retry');
      if (btn) btn.addEventListener('click', function () {
        sessionStorage.setItem(KEY, '0'); location.reload();
      });
      if (n >= MAX) { if (status) status.textContent = 'Still not up. Use Retry when it is.'; return; }
      var left = Math.round(DELAY / 1000);
      function tick() {
        if (status) status.textContent = left > 0 ? 'Checking again in ' + left + 's\\u2026' : 'Checking\\u2026';
        left -= 1;
      }
      tick();
      var t = setInterval(tick, 1000);
      setTimeout(function () {
        clearInterval(t);
        sessionStorage.setItem(KEY, String(n + 1));
        location.reload();
      }, DELAY);
    })();`
    : '';

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
    --background: oklch(1 0 0);
    --foreground: oklch(0 0 0);
    --secondary: oklch(0.9431 0 0);
    --muted-foreground: oklch(0.5103 0 0);
    --kortix-yellow: oklch(0.732 0.15 90.688);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.1398 0 0);
      --foreground: oklch(1 0 0);
      --secondary: oklch(0.2264 0 0);
      --muted-foreground: oklch(0.683 0 0);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--secondary); color: var(--foreground); padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    text-align: center; max-width: 400px;
  }
  h1 { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; margin: 0; }
  p { font-size: 13px; color: var(--muted-foreground); margin: 0; }
  .dot {
    width: 8px; height: 8px; border-radius: 999px; background: var(--kortix-yellow);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 30px; padding: 0 14px; margin-top: 4px; border: 0; border-radius: 8px;
    font: inherit; font-size: 13px; font-weight: 500; text-decoration: none; cursor: pointer;
    background: var(--foreground); color: var(--background);
    transition: opacity .15s;
  }
  .btn:hover { opacity: .9; }
  .status { font-size: 12px; color: var(--muted-foreground); min-height: 16px; margin: 0; }
  code {
    font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--muted-foreground); word-break: break-all;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${copy.autoRetry ? '<span class="dot"></span>' : ''}${escapeHtml(copy.title)}</h1>
    <p>${escapeHtml(copy.body)}</p>
    ${action}
    <p class="status" id="status"></p>
    <code>${escapeHtml(input.returnTo)}</code>
  </div>
  <script>${signInScript}${retryScript}</script>
</body>
</html>`;
}
