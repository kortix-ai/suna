/**
 * Helpers for WebViews that render untrusted file content in generated HTML.
 */

/**
 * Makes `JSON.stringify` output safe inside an inline `<script>` block.
 * `<` becomes `\u003c`, so `</script>` and `<!--` cannot end or change the
 * script element. U+2028 and U+2029 are escaped for pre-ES2019 parsers.
 * The result evaluates to the same value.
 */
export function escapeForInlineScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export type PreviewNavigation = 'allow' | 'open-external' | 'block';

export interface PreviewNavigationOptions {
  /** Origin (scheme://host[:port]) whose pages load inside the WebView. */
  allowedOrigin?: string;
  /** Allow file:// loads (the iOS PDF preview loads a cached file). */
  allowFileUrls?: boolean;
  /** From the WebView request; `false` for iframe loads (iOS only). */
  isTopFrame?: boolean;
  /** From the WebView request. iOS reports `'click'` for a link tap; Android never does. */
  navigationType?: string;
  /**
   * Open outside the app only for a user click. Every other external
   * navigation (script redirect, form submit, iframe, or any Android request)
   * is blocked without opening anything.
   */
  externalRequiresClick?: boolean;
  /**
   * `'preview'` (default): a file preview, as described on
   * `decidePreviewNavigation`. `'browser'`: the in-app browser, where every
   * http(s) page loads inside the WebView and nothing opens outside the app.
   */
  mode?: 'preview' | 'browser';
}

function originOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

function openExternal(options: PreviewNavigationOptions): PreviewNavigation {
  if (options.externalRequiresClick && options.navigationType !== 'click') return 'block';
  return 'open-external';
}

/**
 * Navigation policy for preview WebViews. Inline document loads stay in the
 * WebView. Top-frame web and mail links open outside the app. Every other
 * scheme (javascript:, intent:, app deep links) is blocked.
 *
 * In `'browser'` mode http(s) loads in the WebView from any origin and frame,
 * and every other scheme (mailto:, tel:, intent:, market:, app deep links) is
 * blocked, so a page cannot launch another app.
 */
export function decidePreviewNavigation(
  url: string,
  options: PreviewNavigationOptions = {},
): PreviewNavigation {
  const lower = url.toLowerCase();
  const hash = lower.indexOf('#');
  const withoutFragment = hash === -1 ? lower : lower.slice(0, hash);

  // A fragment on the inline document is an in-page anchor (a DOCX table of contents).
  if (withoutFragment === 'about:blank' || withoutFragment === 'about:srcdoc') return 'allow';
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return 'allow';
  if (lower.startsWith('file:')) return options.allowFileUrls ? 'allow' : 'block';

  const isWeb = lower.startsWith('http://') || lower.startsWith('https://');
  if (options.mode === 'browser') return isWeb ? 'allow' : 'block';

  if (isWeb) {
    const allowedOrigin = options.allowedOrigin ? originOf(options.allowedOrigin) : null;
    if (options.isTopFrame === false) return allowedOrigin ? 'allow' : 'block';
    if (allowedOrigin && originOf(url) === allowedOrigin) return 'allow';
    return openExternal(options);
  }
  if (lower.startsWith('mailto:')) return openExternal(options);

  return 'block';
}

/**
 * `onShouldStartLoadWithRequest` for the in-app browser WebViews, whose pages
 * the agent controls. Pair it with `originWhitelist={['*']}`: otherwise
 * react-native-webview opens every non-http(s) URL outside the app itself,
 * without a tap, before this guard runs.
 */
export function allowBrowserNavigation(request: { url: string }): boolean {
  return decidePreviewNavigation(request.url, { mode: 'browser' }) === 'allow';
}

/**
 * Page-script source that defines `sanitizeUntrustedHtml(root)`. It removes
 * active and embedding elements and every on* handler and style attribute.
 * Link attributes (href, xlink:href, cite) keep only http:, https:, mailto:,
 * and # values. Resource attributes the page would fetch on open (src,
 * poster, background, data) are removed, except an `img src` that is a
 * `data:image/` URI (DOCX embeds images that way): a remote image would send
 * the viewer's IP and an open event to its host.
 * Run it on a DOMParser document before the nodes enter the live page.
 *
 * Written without backslashes, backticks, or `${` so it embeds verbatim in a
 * template literal.
 */
export const HTML_SANITIZER_SCRIPT = `
var SANITIZER_BLOCKED_TAGS = {
  script: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, applet: 1,
  link: 1, meta: 1, base: 1, form: 1, style: 1, svg: 1, math: 1, template: 1, noscript: 1
};
var SANITIZER_LINK_ATTRS = { href: 1, 'xlink:href': 1, cite: 1 };
var SANITIZER_RESOURCE_ATTRS = { src: 1, poster: 1, background: 1, data: 1 };
var SANITIZER_DROPPED_ATTRS = { style: 1, srcset: 1, action: 1, formaction: 1 };

function sanitizerCompactUrl(value) {
  var raw = String(value).slice(0, 64);
  var compact = '';
  for (var i = 0; i < raw.length; i++) {
    var code = raw.charCodeAt(i);
    if (code > 32 && code !== 127) compact += raw.charAt(i);
  }
  return compact.toLowerCase();
}

function sanitizerIsSafeLink(value) {
  var compact = sanitizerCompactUrl(value);
  if (compact.charAt(0) === '#') return true;
  return compact.indexOf('http:') === 0 || compact.indexOf('https:') === 0 || compact.indexOf('mailto:') === 0;
}

function sanitizeUntrustedHtml(root) {
  var elements = root.querySelectorAll('*');
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var tag = String(el.tagName).toLowerCase();
    if (SANITIZER_BLOCKED_TAGS[tag] === 1) {
      if (el.parentNode) el.parentNode.removeChild(el);
      continue;
    }
    var attrs = el.attributes;
    for (var k = attrs.length - 1; k >= 0; k--) {
      var attrName = attrs[k].name;
      var name = String(attrName).toLowerCase();
      if (name.indexOf('on') === 0 || SANITIZER_DROPPED_ATTRS[name] === 1) {
        el.removeAttribute(attrName);
      } else if (SANITIZER_LINK_ATTRS[name] === 1) {
        if (!sanitizerIsSafeLink(attrs[k].value)) el.removeAttribute(attrName);
      } else if (SANITIZER_RESOURCE_ATTRS[name] === 1) {
        var embeddedImage = tag === 'img' && name === 'src' &&
          sanitizerCompactUrl(attrs[k].value).indexOf('data:image/') === 0;
        if (!embeddedImage) el.removeAttribute(attrName);
      }
    }
  }
}
`;
