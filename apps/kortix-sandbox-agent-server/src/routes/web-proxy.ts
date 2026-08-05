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

import { Hono, type Context } from 'hono'
import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'

import { logger } from '../logger'
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

/**
 * Headers that authenticate the CALLER TO US, and must never leave the box.
 *
 * This is a forward proxy to a host the CALLER NAMES, so every header copied
 * onto the upstream request is handed to that host. apps/api authenticates every
 * request it relays here — an ordinary user's included — with the sandbox's own
 * service key, and adds a signed user-context plus the sandbox provider's
 * preview token (buildSandboxUpstreamHeaders, apps/api/src/sandbox-proxy/backend.ts).
 * Copying those onto `/web-proxy/https/attacker.example/` mailed them out.
 *
 * The service key is the worst of them: it is also the HMAC secret for
 * X-Kortix-User-Context, so whoever holds it can mint a context claiming any
 * userId and any role for this sandbox, and it satisfies every bearer-only
 * daemon check.
 *
 * Stripped for EVERY target, loopback included — the in-box agent must not be
 * able to read them back out of a request either. The sibling port proxy
 * already strips `authorization` for exactly this reason (port-proxy.ts);
 * this proxy, the one that reaches the open internet, did not.
 */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-kortix-user-context',
  'x-kortix-service-call',
  // Sandbox-provider preview credentials (daytona.ts, e2b.ts).
  'x-daytona-preview-token',
  'e2b-traffic-access-token',
])

/**
 * Every address that belongs to THIS machine.
 *
 * Loopback is not enough. The daemon binds 0.0.0.0, so the box's own interface
 * address — its eth0 10.x/172.x — reaches :8000 exactly as 127.0.0.1 does, and
 * a guard that only knew about loopback let that spelling through.
 *
 * Computed once: a sandbox's addresses do not change during its life, and this
 * sits in the path of every proxied asset request.
 */
let ownAddressCache: Set<string> | null = null
function ownAddresses(): Set<string> {
  if (ownAddressCache) return ownAddressCache
  const found = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Drop the IPv6 zone index (`fe80::1%eth0`) — it is not part of the address.
      found.add(entry.address.toLowerCase().split('%')[0] as string)
    }
  }
  ownAddressCache = found
  return found
}

/** Does this literal address reach the box itself? */
function isLoopbackAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] as string
  if (a === '::1' || a === '::' || a === '0.0.0.0') return true
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  if (a.startsWith('::ffff:')) return isLoopbackAddress(a.slice('::ffff:'.length))
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return true
  // The box's own non-loopback bind addresses. Same destination, different route.
  return ownAddresses().has(a)
}

/**
 * Does this hostname name the box itself, by spelling alone?
 *
 * `new URL()` has already folded the inet_aton forms for us — `127.1`,
 * `2130706433`, `0x7f000001` all arrive here as `127.0.0.1`, and `0` as
 * `0.0.0.0` — verified against Bun, so this only has to handle NAMES.
 *
 * The trailing dot is the DNS root label: `localhost.` and `foo.localhost.`
 * resolve exactly like the undotted forms, and reached the control plane until
 * this stripped them.
 */
function isLoopbackName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return isLoopbackAddress(host)
}

/**
 * Does this host reach the box, by any spelling OR by DNS?
 *
 * Matching on the name alone is not enough and never can be: `127.0.0.1.nip.io`
 * is a ready-made public name for 127.0.0.1, and any attacker-controlled domain
 * becomes one with a single A record. So resolve it and judge the ADDRESS.
 *
 * KNOWN RESIDUAL: this resolves and then fetches, so a DNS rebind between the
 * two calls still slips through. Closing that needs the connection pinned to the
 * address we checked, which Bun's fetch does not expose. It is a much narrower
 * hole than the spelling bypass — it needs attacker-controlled DNS and a won
 * race — and the credential strip above is unconditional, so a request that does
 * win the race still carries none of our secrets.
 */
async function reachesThisBox(
  hostname: string,
): Promise<{ self: boolean; address: string | null }> {
  if (isLoopbackName(hostname)) return { self: true, address: null }
  try {
    const resolved = await lookup(hostname.replace(/\.+$/, ''), { all: true })
    if (resolved.some((entry) => isLoopbackAddress(entry.address))) {
      return { self: true, address: null }
    }
    // Handed back so the caller can CONNECT to the address it just vetted,
    // instead of resolving a second time and trusting the answer to match.
    return { self: false, address: resolved[0]?.address ?? null }
  } catch {
    // Unresolvable. The fetch below fails on its own; do not turn a DNS blip
    // into a spurious 403 for a legitimate site.
    return { self: false, address: null }
  }
}

export interface WebProxyOptions {
  /**
   * Ports this proxy refuses to reach ON THIS BOX — our own control plane.
   *
   * Named for the destination, not for loopback: the daemon binds 0.0.0.0
   * (proxy.ts), so the box's own interface address reaches it just as
   * 127.0.0.1 does, and a guard that thought in terms of "loopback" missed
   * that spelling entirely.
   */
  blockedSelfPorts: ReadonlySet<number>
}

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

async function handleWebProxy(c: Context, opts: WebProxyOptions): Promise<Response> {
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

  // Keep the web proxy off the box's OWN control plane.
  //
  // Browsing a dev server the agent started (`localhost:3000`) is the point of
  // this proxy. Re-entering the daemon (:8000) or opencode (:4096) is not: those
  // are reached from outside through apps/api, which enforces a stack of
  // path-keyed controls on the way — the agent-authorization check, the
  // connector gate, the 24h run cap, prompt idempotency, and the secret-grant
  // re-mint. A request tunnelled through here arrives on loopback with the path
  // buried in OUR url, so every one of those is skipped and the caller runs a
  // turn apps/api would have refused.
  const targetPort = parsedTarget.port
    ? Number(parsedTarget.port)
    : parsedTarget.protocol === 'https:'
      ? 443
      : 80
  //
  // `fetchTarget` is what we actually connect to. It differs from `targetUrl`
  // only when we had to vet the destination — everything else (HTML rewriting,
  // redirect resolution, logs) keeps the original host, which is what the
  // browser needs to see.
  let fetchTarget = targetUrl
  if (opts.blockedSelfPorts.has(targetPort)) {
    const target = await reachesThisBox(parsedTarget.hostname)
    if (target.self) {
      logger.warn('[web-proxy] refused a request to the box control plane', {
        host: parsedTarget.hostname,
        port: targetPort,
      })
      return c.json(
        {
          error: 'this port is not reachable through the web proxy',
          code: 'WEB_PROXY_PORT_BLOCKED',
        },
        403,
      )
    }
    // PIN THE CONNECTION TO THE ADDRESS WE VETTED.
    //
    // Otherwise the check is resolve-then-fetch, and a DNS rebind between the
    // two — TTL 0, second answer 127.0.0.1 — sends us to the control plane we
    // just refused. Connecting by address closes that window; the Host header
    // is already the original host, so the upstream still sees what it expects.
    //
    // http only, and that is sufficient rather than lazy: the rebind target
    // would have to be our own loopback control plane, and neither the daemon
    // nor opencode speaks TLS there, so an https request cannot complete a
    // handshake against it. Leaving https alone also keeps SNI and certificate
    // validation intact, which pinning by IP would break.
    if (target.address && parsedTarget.protocol === 'http:') {
      const pinned = new URL(targetUrl)
      pinned.hostname = target.address
      fetchTarget = pinned.toString()
    }
  }

  const headers = buildUpstreamHeaders(c, CREDENTIAL_HEADERS)
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

      const response = await fetch(fetchTarget, {
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
}

export function createWebProxyRouter(opts: WebProxyOptions): Hono {
  const webProxyRouter = new Hono()
  webProxyRouter.all('/*', (c) => handleWebProxy(c, opts))
  return webProxyRouter
}
