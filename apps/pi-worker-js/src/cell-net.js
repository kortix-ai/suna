// NETWORK FOR THE CELL'S SHELL: curl and wget over the isolate's own fetch.
//
// just-bash registers `curl` when a fetch is supplied, and its own secure
// fetch refuses everything in an isolate — its private-range check resolves
// DNS, and with no resolver every request answered "DNS resolution failed for
// private IP check" (measured under node with the browser build, 2026-09-10).
// So the fetch is this one: the platform's `fetch`, with the checks an isolate
// CAN make — scheme, a lexical private/loopback/link-local address deny that
// is applied to every redirect hop, a timeout and a body cap. A name that
// resolves to an internal address is the host's egress policy to refuse; the
// cell cannot see what a name resolves to.
//
// `wget` is not in this just-bash; a small one is defined over the same fetch
// so `wget -qO- URL` and `wget URL` do what a model expects of them.

import { defineCommand } from "just-bash/browser";

export const NET_TIMEOUT_MS = 30_000;
export const NET_MAX_BODY = 10 * 1024 * 1024;
export const NET_MAX_REDIRECTS = 10;

const PRIVATE_V4 = [
  [/^10\./, "10/8"], [/^127\./, "127/8"], [/^0\./, "0/8"], [/^169\.254\./, "169.254/16"],
  [/^192\.168\./, "192.168/16"], [/^172\.(1[6-9]|2\d|3[01])\./, "172.16/12"], [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, "100.64/10"],
];

/** Why a URL may not be fetched from the cell, or null when it may. */
export function denyReason(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return "malformed URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme ${u.protocol.replace(/:$/, "")} is not allowed`;
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return `host ${host} is not reachable from a cell`;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) and plain IPv6 ranges.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (mapped) host = mapped[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    for (const [re, range] of PRIVATE_V4) if (re.test(host)) return `address ${host} is in ${range}, not reachable from a cell`;
    return null;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return `address ${host} is loopback, not reachable from a cell`;
    if (/^f[cd]/i.test(host)) return `address ${host} is a unique-local address, not reachable from a cell`;
    if (/^fe[89ab]/i.test(host)) return `address ${host} is link-local, not reachable from a cell`;
  }
  // Decimal / hex / octal IPv4 spellings (http://2130706433/, 0x7f000001) are
  // refused outright: nothing legitimate is addressed that way.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return `numeric host ${host} is not allowed`;
  return null;
}

class NetworkAccessDeniedError extends Error {
  constructor(url, reason) { super(`Network access denied: ${reason}: ${url}`); this.name = "NetworkAccessDeniedError"; }
}

/**
 * A just-bash SecureFetch: (url, {method, headers, body, followRedirects, timeoutMs})
 * → {status, statusText, headers, body: Uint8Array, url}. Redirects are walked
 * here, one hop at a time, so each target passes the same deny.
 */
export function guardedFetch(fetchImpl = globalThis.fetch, limits = {}) {
  const maxBody = limits.maxBody ?? NET_MAX_BODY;
  const maxRedirects = limits.maxRedirects ?? NET_MAX_REDIRECTS;
  const defaultTimeout = limits.timeoutMs ?? NET_TIMEOUT_MS;
  return async function secureFetch(url, options = {}) {
    let current = String(url);
    const timeoutMs = Math.min(options.timeoutMs ?? defaultTimeout, defaultTimeout);
    const follow = options.followRedirects !== false;
    let method = (options.method ?? "GET").toUpperCase();
    let body = options.body;
    for (let hop = 0; ; hop++) {
      const reason = denyReason(current);
      if (reason) throw new NetworkAccessDeniedError(current, reason);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(current, { method, headers: options.headers, body, redirect: "manual", signal: ctl.signal });
      } finally { clearTimeout(timer); }
      const location = res.headers.get("location");
      if (follow && location && res.status >= 300 && res.status < 400) {
        if (hop >= maxRedirects) throw new Error(`Too many redirects (${maxRedirects}): ${current}`);
        current = new URL(location, current).toString();
        // Same rewrite a real client makes: 303 (and 301/302 on POST) become GET without a body.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > maxBody) throw new Error(`Response too large (${buf.length} bytes, limit ${maxBody}): ${current}`);
      const headers = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return { status: res.status, statusText: res.statusText, headers, body: buf, url: current };
    }
  };
}

/** `wget [-q] [-O FILE|-] URL...` — enough of wget for a model's habits. */
export function wgetCommand(secureFetch) {
  return defineCommand("wget", async (args, ctx) => {
    let quiet = false, out = null;
    const urls = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-q" || a === "--quiet") quiet = true;
      else if (a === "-qO-" || a === "-qO" || a === "-O-") { quiet = quiet || a.startsWith("-q"); out = a.endsWith("-") ? "-" : args[++i]; }
      else if (a === "-O" || a === "--output-document") out = args[++i];
      else if (a.startsWith("--output-document=")) out = a.slice("--output-document=".length);
      else if (a.startsWith("-")) { /* other flags are accepted and ignored */ }
      else urls.push(a);
    }
    if (!urls.length) return { stdout: "", stderr: "wget: missing URL\nUsage: wget [OPTION]... [URL]...\n", exitCode: 1 };
    let stdout = "", stderr = "";
    for (const url of urls) {
      let r;
      try { r = await secureFetch(url); } catch (e) { stderr += `wget: ${e.message}\n`; return { stdout, stderr, exitCode: 4 }; }
      if (r.status >= 400) { stderr += `wget: server returned error: HTTP/1.1 ${r.status} ${r.statusText}\n`; return { stdout, stderr, exitCode: 8 }; }
      const text = new TextDecoder().decode(r.body);
      if (out === "-") stdout += text;
      else {
        const name = out ?? (new URL(url).pathname.split("/").filter(Boolean).pop() || "index.html");
        const target = name.startsWith("/") ? name : `${ctx.cwd}/${name}`;
        await ctx.fs.writeFile(target, r.body);
        if (!quiet) stderr += `'${name}' saved [${r.body.length}]\n`;
      }
    }
    return { stdout, stderr, exitCode: 0 };
  });
}
