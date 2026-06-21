/**
 * Desktop OAuth bounce page.
 *
 * When Supabase 302's a desktop user's BROWSER to the web `/auth/callback`,
 * we don't exchange the code on the web side — we hand it back to the native
 * app via the `kortix://auth/callback` deep link and leave the browser on a
 * friendly "you can close this tab" page.
 *
 * SECURITY: the deep link is built from request query params, so it is
 * attacker-influenced. It is embedded in two HTML sinks — an `href` attribute
 * and an inline `<script>`. Both are escaped for their context here:
 *
 *   - `escapeHtmlAttribute` for the `href`.
 *   - `serializeForInlineScript` for the script. `JSON.stringify` alone is NOT
 *     safe inside `<script>`: it does not escape `</script>`, `<!--`, or the
 *     line separators U+2028/U+2029, any of which can terminate the script
 *     element or the string literal. We unicode-escape `<`, `>`, `&`, U+2028
 *     and U+2029 so the payload can never break out of the element, independent
 *     of any upstream URL-encoding.
 */

/** Escape a value for safe interpolation into an HTML attribute value. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialize a value to a JS literal that is safe to embed inside an inline
 * `<script>` element. Returns valid JSON (so it round-trips through JSON.parse)
 * with the HTML/JS-significant characters unicode-escaped: `<`, `>`, `&`, and
 * the U+2028/U+2029 line separators.
 */
export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase(),
  );
}

/**
 * Build the `kortix://auth/callback` deep link from an inbound web callback.
 * A supplied transport marker is omitted; every value is re-encoded via
 * URLSearchParams before it reaches either native client.
 */
export function buildNativeDeepLink(searchParams: URLSearchParams, transportFlag?: string): string {
  const forwardParams = new URLSearchParams();
  for (const [k, v] of searchParams) {
    if (!transportFlag || k !== transportFlag) forwardParams.set(k, v);
  }
  const qs = forwardParams.toString();
  return `kortix://auth/callback${qs ? `?${qs}` : ''}`;
}

/** Build the desktop callback deep link, dropping the desktop marker. */
export function buildDesktopDeepLink(searchParams: URLSearchParams): string {
  return buildNativeDeepLink(searchParams, 'desktop');
}

/** Build the mobile callback deep link, retaining the registration marker. */
export function buildMobileDeepLink(searchParams: URLSearchParams): string {
  // Unlike desktop, mobile needs this marker after the browser fallback so it
  // can admit a newly-created user only for a state-validated web handoff.
  return buildNativeDeepLink(searchParams);
}

/** Render the native handoff document, optionally starting the app automatically. */
function buildNativeBounceHtml(deepLink: string, autoOpen: boolean): string {
  const hrefSafe = escapeHtmlAttribute(deepLink);
  const scriptSafe = serializeForInlineScript(deepLink);
  const message = autoOpen
    ? `Opening Kortix… you can close this tab.<br/>
    If nothing happens, <a href="${hrefSafe}">click here</a> to open the app.`
    : `Your sign-in is ready.<br/>
    <a href="${hrefSafe}">Open Kortix</a> to continue.`;
  const automaticRedirect = autoOpen
    ? `<script>window.location.replace(${scriptSafe});</script>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>Opening Kortix…</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  html,body{margin:0;height:100%;background:#0a0a0a;color:#f4f4f5;
    font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}
  .wrap{display:grid;place-items:center;height:100%;text-align:center;padding:24px;}
  h1{font-size:22px;font-weight:500;margin:0 0 10px;letter-spacing:-0.01em;}
  p{margin:0;color:#a1a1aa;font-size:13px;line-height:1.6;max-width:340px;}
  a{color:#f4f4f5;text-decoration:underline;text-underline-offset:3px;}
  .dot{width:6px;height:6px;border-radius:50%;background:currentColor;
    display:inline-block;margin:0 2px;opacity:.4;animation:pulse 1.2s infinite both;}
  .dot:nth-child(2){animation-delay:.2s;}.dot:nth-child(3){animation-delay:.4s;}
  @keyframes pulse{0%,80%,100%{opacity:.2}40%{opacity:1}}
  .dots{margin-bottom:18px;color:#52525b;}
</style></head><body>
<div class="wrap"><div>
  <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <h1>You're signed in</h1>
  <p>${message}</p>
</div></div>
${automaticRedirect}
</body></html>`;
}

/** Render the desktop browser fallback page. */
export function buildDesktopBounceHtml(searchParams: URLSearchParams): string {
  return buildNativeBounceHtml(buildDesktopDeepLink(searchParams), true);
}

/** Render the mobile browser fallback page. */
export function buildMobileBounceHtml(searchParams: URLSearchParams): string {
  // iOS Safari rejects programmatic custom-scheme navigation as an invalid
  // address. The universal link opens the installed app automatically; this
  // page is only its browser fallback, where an explicit user tap is reliable.
  return buildNativeBounceHtml(buildMobileDeepLink(searchParams), false);
}
