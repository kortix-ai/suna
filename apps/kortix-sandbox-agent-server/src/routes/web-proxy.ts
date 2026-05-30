/**
 * Web Forward Proxy — /web-proxy/{scheme}/{host}/{path}
 *
 * Transparent forward proxy: fetches ANY URL from within the sandbox
 * and relays the response back. Designed to power the Internal Browser
 * feature, making it behave as if the user is browsing from inside
 * the sandbox machine.
 *
 * URL scheme:
 *   /web-proxy/https/example.com/path?q=test  → GET https://example.com/path?q=test
 *   /web-proxy/http/localhost:3000/api/users   → GET http://localhost:3000/api/users
 *
 * For HTML responses:
 *   1. Strips security headers (CSP, X-Frame-Options) so iframe embedding works
 *   2. Injects <base> tag for relative URL resolution
 *   3. Rewrites absolute URLs in HTML attributes through the proxy
 *   4. Injects a JS runtime that patches fetch/XHR/WebSocket/navigation
 *      to route all requests through the proxy — this is the primary
 *      mechanism ensuring true 1:1 transparent proxying
 *
 * For CSS responses:
 *   - Rewrites url() references to route through the proxy
 *
 * For all other content (JS, images, fonts, etc.):
 *   - Streams through unchanged (byte-perfect passthrough)
 *
 * Resilience: same retry/timeout/abort patterns as the port proxy.
 */

import { Hono } from 'hono'
import {
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  isTransientError,
  isConnectionRefused,
  buildUpstreamHeaders,
  readBodyOnce,
  createClientAbort,
  detectSSE,
  getFetchSignal,
} from './proxy-utils'

const webProxyRouter = new Hono()

const STRIP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'content-encoding',    // We decompress to rewrite; don't claim it's still compressed
  'content-length',      // Content length changes after rewriting
  'transfer-encoding',   // Remove chunked encoding — we buffer for rewriting
])

// ── URL Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse the target URL from the sub-path after the router mount point.
 *
 * @param subPath - e.g. "/https/example.com/page" or "/http/localhost:3000/api"
 * @param search  - query string from the request, e.g. "?q=test"
 */
function parseTargetUrl(subPath: string, search: string): string | null {
  const match = subPath.match(/^\/(https?)\/([\w.\-]+(?::\d+)?)(\/.*)?$/)
  if (!match) return null

  const scheme = match[1]
  const host = match[2]
  const path = match[3] || '/'
  const candidate = `${scheme}://${host}${path}${search}`

  try {
    new URL(candidate)
  } catch {
    return null
  }

  return candidate
}

/**
 * Build the proxy-path prefix for a given target origin.
 *   "https://example.com" → "/web-proxy/https/example.com"
 */
function proxyPrefixForOrigin(targetOrigin: string): string {
  try {
    const url = new URL(targetOrigin)
    const scheme = url.protocol.replace(':', '')
    return `/web-proxy/${scheme}/${url.host}`
  } catch {
    return '/web-proxy'
  }
}

// ── HTML Rewriting ───────────────────────────────────────────────────────────

function rewriteHtmlUrls(html: string, targetOrigin: string): string {
  const prefix = proxyPrefixForOrigin(targetOrigin)
  let result = html

  // 1. Full absolute URLs: href="https://example.com/path"
  result = result.replace(
    /((?:href|src|action|poster|data|formaction)\s*=\s*["'])\s*(https?):\/\/([\w.\-]+(?::\d+)?)(\/[^"'\s>]*)?(?=["'])/gi,
    (_m, attr, scheme, host, path) =>
      `${attr}/web-proxy/${scheme}/${host}${path || '/'}`
  )

  // 2. Protocol-relative: src="//cdn.example.com/lib.js"
  result = result.replace(
    /((?:href|src|action|poster|data|formaction)\s*=\s*["'])\s*\/\/([\w.\-]+(?::\d+)?)(\/[^"'\s>]*)?(?=["'])/gi,
    (_m, attr, host, path) =>
      `${attr}/web-proxy/https/${host}${path || '/'}`
  )

  // 3. Root-relative: href="/about"  (must stay under the same target origin)
  result = result.replace(
    /((?:href|src|action|poster|data|formaction)\s*=\s*["'])(\/(?!\/|web-proxy\/)[^"'\s>]*)(?=["'])/gi,
    (_m, attr, path) => `${attr}${prefix}${path}`
  )

  // 4. srcset (comma-separated URL + descriptor pairs)
  result = result.replace(
    /(srcset\s*=\s*["'])([^"']+)(?=["'])/gi,
    (_m, attr, value) => {
      const rewritten = value
        // Absolute URLs
        .replace(
          /(https?):\/\/([\w.\-]+(?::\d+)?)(\/[^\s,]*)/g,
          (_u: string, s: string, h: string, p: string) => `/web-proxy/${s}/${h}${p}`,
        )
        // Root-relative
        .replace(
          /(^|,\s*)(\/(?!web-proxy\/)[^\s,]+)/g,
          (_u: string, sep: string, p: string) => `${sep}${prefix}${p}`,
        )
      return `${attr}${rewritten}`
    },
  )

  // 5. Inline style url() — absolute
  result = result.replace(
    /url\(\s*["']?\s*(https?):\/\/([\w.\-]+(?::\d+)?)(\/[^)"'\s]*)\s*["']?\s*\)/gi,
    (_m, scheme, host, path) => `url("/web-proxy/${scheme}/${host}${path}")`,
  )

  // 6. Inline style url() — root-relative
  result = result.replace(
    /url\(\s*["']?\s*(\/(?!web-proxy\/)[^)"'\s]*)\s*["']?\s*\)/gi,
    (_m, path) => `url("${prefix}${path}")`,
  )

  return result
}

// ── CSS Rewriting ────────────────────────────────────────────────────────────

function rewriteCssUrls(css: string, targetOrigin: string): string {
  const prefix = proxyPrefixForOrigin(targetOrigin)
  let result = css

  // url() — absolute
  result = result.replace(
    /url\(\s*["']?\s*(https?):\/\/([\w.\-]+(?::\d+)?)(\/[^)"'\s]*)\s*["']?\s*\)/gi,
    (_m, scheme, host, path) => `url("/web-proxy/${scheme}/${host}${path}")`,
  )

  // url() — protocol-relative
  result = result.replace(
    /url\(\s*["']?\s*\/\/([\w.\-]+(?::\d+)?)(\/[^)"'\s]*)\s*["']?\s*\)/gi,
    (_m, host, path) => `url("/web-proxy/https/${host}${path}")`,
  )

  // url() — root-relative
  result = result.replace(
    /url\(\s*["']?\s*(\/(?!web-proxy\/)[^)"'\s]*)\s*["']?\s*\)/gi,
    (_m, path) => `url("${prefix}${path}")`,
  )

  // @import "url"
  result = result.replace(
    /@import\s+["'](https?):\/\/([\w.\-]+(?::\d+)?)(\/[^"']*)["']/gi,
    (_m, scheme, host, path) => `@import "/web-proxy/${scheme}/${host}${path}"`,
  )

  result = result.replace(
    /@import\s+["'](\/(?!web-proxy\/)[^"']*)["']/gi,
    (_m, path) => `@import "${prefix}${path}"`,
  )

  return result
}

// ── JS Runtime ───────────────────────────────────────────────────────────────

/**
 * Client-side JS runtime injected into HTML responses. Patches browser APIs
 * so that ALL requests — fetch, XHR, navigation, dynamic DOM — route through
 * the proxy. This is the primary mechanism for true 1:1 transparent proxying.
 */
function generateRuntime(targetOrigin: string): string {
  // Use a heredoc-style template. The runtime is intentionally written in ES5
  // for maximum compatibility with arbitrary web pages.
  return `<script data-web-proxy-runtime>
(function(){
var P='/web-proxy/';
var TO=${JSON.stringify(targetOrigin)};
var TU;try{TU=new URL(TO)}catch(e){return}
var TS=TU.protocol.replace(':','');
var TH=TU.host;
var OP=P+TS+'/'+TH;

function rw(u,b){
  if(!u||typeof u!=='string')return u;
  u=u.trim();
  if(u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('javascript:')||u==='#'||u.startsWith('#')||u.startsWith('mailto:')||u.startsWith('tel:'))return u;
  if(u.indexOf(P)===0)return u;
  try{
    var r;
    if(/^https?:\\/\\//.test(u)){r=new URL(u)}
    else if(u.startsWith('//')){r=new URL('https:'+u)}
    else if(u.startsWith('/')){r=new URL(TO+u)}
    else{
      var cp=location.pathname;
      if(cp.indexOf(OP)===0){
        var tp=cp.slice(OP.length)||'/';
        var dir=tp.substring(0,tp.lastIndexOf('/')+1)||'/';
        r=new URL(u,TO+dir);
      }else{r=new URL(u,TO+'/')}
    }
    if(r.protocol==='http:'||r.protocol==='https:'){
      var s=r.protocol.replace(':','');
      return P+s+'/'+r.host+r.pathname+r.search+r.hash;
    }
  }catch(e){}
  return u;
}

// Patch fetch
var oF=window.fetch;
window.fetch=function(i,n){
  if(typeof i==='string'){i=rw(i)}
  else if(i&&typeof i==='object'&&i.url){
    var nu=rw(i.url);if(nu!==i.url){i=new Request(nu,i)}
  }
  return oF.call(this,i,n);
};

// Patch XHR
var oX=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  arguments[1]=rw(u);return oX.apply(this,arguments);
};

// Patch window.open
var oW=window.open;
window.open=function(u){
  if(typeof u==='string')arguments[0]=rw(u);
  return oW.apply(this,arguments);
};

// Patch history
var oP=history.pushState,oR=history.replaceState;
history.pushState=function(s,t,u){
  if(u)arguments[2]=rw(String(u));return oP.apply(this,arguments);
};
history.replaceState=function(s,t,u){
  if(u)arguments[2]=rw(String(u));return oR.apply(this,arguments);
};

// Intercept clicks on <a>
document.addEventListener('click',function(e){
  var el=e.target;
  while(el&&el.tagName!=='A')el=el.parentElement;
  if(!el||!el.href)return;
  var h=el.getAttribute('href');
  if(!h||h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('mailto:')||h.startsWith('tel:'))return;
  var nr=rw(h);
  if(nr!==h){e.preventDefault();location.href=nr}
},true);

// Intercept form submissions
document.addEventListener('submit',function(e){
  var f=e.target;if(!f||!f.action)return;
  var a=f.getAttribute('action');
  if(a){var na=rw(a);if(na!==a)f.setAttribute('action',na)}
},true);

// Patch property setters for URL-bearing attributes
function pp(pr,p){
  try{
    var d=Object.getOwnPropertyDescriptor(pr,p);
    if(!d||!d.set)return;
    var os=d.set;
    Object.defineProperty(pr,p,{
      set:function(v){if(typeof v==='string')v=rw(v);os.call(this,v)},
      get:d.get,configurable:true,enumerable:d.enumerable
    });
  }catch(e){}
}
pp(HTMLAnchorElement.prototype,'href');
pp(HTMLImageElement.prototype,'src');
pp(HTMLScriptElement.prototype,'src');
pp(HTMLIFrameElement.prototype,'src');
pp(HTMLSourceElement.prototype,'src');
pp(HTMLLinkElement.prototype,'href');
pp(HTMLFormElement.prototype,'action');
try{pp(HTMLMediaElement.prototype,'src')}catch(e){}
try{pp(HTMLObjectElement.prototype,'data')}catch(e){}
try{pp(HTMLEmbedElement.prototype,'src')}catch(e){}

// Patch setAttribute for URL attributes
var oSA=Element.prototype.setAttribute;
var UA=new Set(['href','src','action','poster','data','formaction']);
Element.prototype.setAttribute=function(n,v){
  if(UA.has(n.toLowerCase())&&typeof v==='string'){v=rw(v)}
  return oSA.call(this,n,v);
};

// MutationObserver: rewrite URLs on dynamically added elements
function rwEl(el){
  if(el.nodeType!==1)return;
  var attrs=['href','src','action','poster','data'];
  for(var i=0;i<attrs.length;i++){
    var a=el.getAttribute&&el.getAttribute(attrs[i]);
    if(a){var na=rw(a);if(na!==a)oSA.call(el,attrs[i],na)}
  }
  var ch=el.querySelectorAll&&el.querySelectorAll('[href],[src],[action],[poster],[data]');
  if(ch)for(var j=0;j<ch.length;j++)rwEl(ch[j]);
}
var obs=new MutationObserver(function(ms){
  for(var i=0;i<ms.length;i++){
    var ns=ms[i].addedNodes;
    for(var j=0;j<ns.length;j++)rwEl(ns[j]);
  }
});
if(document.documentElement){
  obs.observe(document.documentElement,{childList:true,subtree:true});
}

window.__webProxyRewrite=rw;
})();
</script>`
}

// ── Inject runtime + base into HTML ──────────────────────────────────────────

function transformHtml(html: string, targetUrl: string): string {
  const targetOrigin = new URL(targetUrl).origin
  const prefix = proxyPrefixForOrigin(targetOrigin)

  // Build <base> href: directory of the current page
  const targetPath = new URL(targetUrl).pathname
  const dir = targetPath.endsWith('/') ? targetPath : targetPath.substring(0, targetPath.lastIndexOf('/') + 1) || '/'
  const baseTag = `<base href="${prefix}${dir}">`

  // Rewrite URLs in the HTML
  let result = rewriteHtmlUrls(html, targetOrigin)

  // Remove any existing <base> tags (we'll inject our own)
  result = result.replace(/<base\s[^>]*>/gi, '')

  // Inject <base> + runtime after <head> (or at the start if no <head>)
  const runtime = generateRuntime(targetOrigin)
  const headIndex = result.search(/<head(\s[^>]*)?>|<head>/i)
  if (headIndex !== -1) {
    const headTagEnd = result.indexOf('>', headIndex) + 1
    result = result.slice(0, headTagEnd) + '\n' + baseTag + '\n' + runtime + '\n' + result.slice(headTagEnd)
  } else {
    // No <head> — inject at the very start
    result = baseTag + '\n' + runtime + '\n' + result
  }

  return result
}

// ── Route Handler ────────────────────────────────────────────────────────────

webProxyRouter.all('/*', async (c) => {
  const url = new URL(c.req.url)

  const subPath = url.pathname.replace(/^\/web-proxy/, '') || '/'
  const targetUrl = parseTargetUrl(subPath, url.search)

  if (!targetUrl) {
    return c.json({
      error: 'Invalid web proxy URL',
      hint: 'Format: /web-proxy/{http|https}/{host}/{path}',
    }, 400)
  }

  const parsedTarget = new URL(targetUrl)
  const headers = buildUpstreamHeaders(c)
  headers.set('Host', parsedTarget.host)

  // Rewrite Referer to the target origin so upstream sees a natural referer
  const referer = c.req.header('referer')
  if (referer) {
    try {
      const refUrl = new URL(referer)
      const refPath = refUrl.pathname
      if (refPath.startsWith('/web-proxy/')) {
        const refTarget = parseTargetUrl(refPath.replace('/web-proxy', ''), refUrl.search)
        if (refTarget) headers.set('Referer', refTarget)
        else headers.delete('Referer')
      }
    } catch {
      headers.delete('Referer')
    }
  }

  headers.set('Origin', parsedTarget.origin)
  headers.set('Accept-Encoding', 'gzip, deflate, br')

  const acceptsSSE = detectSSE(c)

  let body: ArrayBuffer | undefined
  try {
    body = await readBodyOnce(c)
  } catch {
    return c.json({ error: 'Failed to read request body' }, 400)
  }

  const clientAbort = createClientAbort(c)

  // ── Retry loop ────────────────────────────────────────────────────────
  let lastError = ''

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (clientAbort.signal.aborted) {
      return new Response(null, { status: 499 })
    }

    try {
      const signal = getFetchSignal(acceptsSSE, clientAbort)

      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body,
        redirect: 'manual',
        signal,
      })

      // ── Build response headers ──────────────────────────────────────
      const responseHeaders = new Headers()
      for (const [key, value] of response.headers.entries()) {
        if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
        responseHeaders.set(key, value)
      }

      // Allow iframe embedding
      responseHeaders.set('X-Frame-Options', 'ALLOWALL')
      responseHeaders.set('Access-Control-Allow-Origin', '*')

      // ── Handle redirects ────────────────────────────────────────────
      const location = responseHeaders.get('location')
      if (location && response.status >= 300 && response.status < 400) {
        try {
          // Resolve the redirect target relative to the current target URL
          const resolved = new URL(location, targetUrl)
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            const scheme = resolved.protocol.replace(':', '')
            responseHeaders.set(
              'location',
              `/web-proxy/${scheme}/${resolved.host}${resolved.pathname}${resolved.search}${resolved.hash}`,
            )
          }
        } catch { /* leave as-is */ }

        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      }

      // ── Determine content type ──────────────────────────────────────
      const contentType = (response.headers.get('content-type') || '').toLowerCase()
      const isHtml = contentType.includes('text/html')
      const isCss = contentType.includes('text/css')
      const needsRewrite = isHtml || isCss

      // ── Non-rewritable: stream through unchanged ────────────────────
      if (!needsRewrite) {
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      }

      // ── Rewrite HTML / CSS ──────────────────────────────────────────
      // Buffer the response to transform it
      const rawText = await response.text()

      let transformed: string
      if (isHtml) {
        transformed = transformHtml(rawText, targetUrl)
      } else {
        // CSS
        const targetOrigin = parsedTarget.origin
        transformed = rewriteCssUrls(rawText, targetOrigin)
      }

      responseHeaders.set('Content-Type', contentType)

      return new Response(transformed, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      lastError = errMsg

      if (clientAbort.signal.aborted) {
        return new Response(null, { status: 499 })
      }

      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        console.error(`[web-proxy] Timeout fetching ${targetUrl} after ${FETCH_TIMEOUT_MS / 1000}s`)
        return c.json({ error: 'Request timed out', target: targetUrl }, 504)
      }

      if (isConnectionRefused(errMsg)) {
        console.error(`[web-proxy] Connection refused for ${targetUrl}: ${errMsg}`)
        return c.json({ error: 'Connection refused', target: targetUrl, details: errMsg }, 502)
      }

      if (isTransientError(errMsg) && attempt < MAX_RETRIES) {
        console.warn(
          `[web-proxy] Transient error (attempt ${attempt + 1}/${MAX_RETRIES + 1}) ` +
          `for ${targetUrl}: ${errMsg}, retrying...`,
        )
        await Bun.sleep(RETRY_DELAY_MS * (attempt + 1))
        continue
      }

      console.error(`[web-proxy] Error fetching ${targetUrl}: ${errMsg}`)
    }
  }

  return c.json({
    error: 'Failed to fetch target URL',
    target: targetUrl,
    details: lastError,
  }, 502)
})

export default webProxyRouter
