const fs = require("fs");
const path = require("path");

const PORT = 3211;
const ALLOWED_ROOTS = ["/workspace", "/tmp", "/home", "/opt"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-cache",
};

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function isHtml(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

function toAbsPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  const decoded = decodeURIComponent(rawPath).trim();
  if (!decoded.startsWith("/")) return null;
  return path.normalize(decoded);
}

function isAllowed(absPath) {
  return ALLOWED_ROOTS.some((root) => absPath === root || absPath.startsWith(root + "/"));
}

/**
 * Resolve the public base URL the *client* used, not the internal one we see.
 *
 * The proxy chain (sandbox-proxy/routes/{preview,local-preview}.ts) rewrites
 * the Host header to the upstream sandbox address before forwarding here, so
 * `req.url` would give us something like `http://127.0.0.1:3211` or
 * `http://kortix-sandbox:8000` — both unreachable from the user's browser.
 *
 * The proxies inject the original public origin into headers:
 *   - X-Forwarded-Prefix: full URL the client used, including any path
 *     prefix the proxy strips (e.g. `https://api.kortix.cloud/v1/p/<id>/3211`
 *     for path-based routing, or `http://p3211-<id>.localhost:8008` for
 *     subdomain routing).
 *   - X-Forwarded-Proto / X-Forwarded-Host: standard fallbacks if no prefix.
 *
 * Without this resolution the injected <base href> ends up pointing at the
 * internal sandbox address, and every relative <link>/<script>/<img> in the
 * served HTML fails with ERR_CONNECTION_REFUSED.
 */
function resolvePublicBaseUrl(req, url) {
  const xfp = req.headers.get("x-forwarded-prefix");
  if (xfp) {
    // Full URL convention used by our proxies — use as-is.
    if (/^https?:\/\//i.test(xfp)) return xfp.replace(/\/$/, "");
    // Standard convention: path-only prefix. Combine with proto+host.
    const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host") || url.host;
    const prefix = xfp.startsWith("/") ? xfp : `/${xfp}`;
    return `${proto}://${host}${prefix}`.replace(/\/$/, "");
  }

  const xfProto = req.headers.get("x-forwarded-proto");
  const xfHost = req.headers.get("x-forwarded-host");
  if (xfProto || xfHost) {
    const proto = xfProto || url.protocol.replace(":", "");
    const host = xfHost || url.host;
    return `${proto}://${host}`;
  }

  // No proxy headers — direct access (curl, local dev). Use what Bun saw.
  return `${url.protocol}//${url.host}`;
}

/**
 * Inject a <base> tag into an HTML document so that all relative URLs
 * (./style.css, ../images/logo.png, script.js, etc.) resolve through the
 * /abs/ route of THIS server rather than against the proxy origin.
 *
 * The base href points at the file's parent directory via the /abs/ route:
 *   <base href="http://host/abs/workspace/project/">
 *
 * With this in place, the browser automatically resolves:
 *   style.css  → http://host/abs/workspace/project/style.css  ✓
 *   ../img/x.png → http://host/abs/workspace/img/x.png       ✓
 */
function injectBase(html, absFilePath, baseUrl) {
  const dir = path.dirname(absFilePath);
  // Build the base href — strip leading "/" then prepend /abs/
  const baseHref = `${baseUrl}/abs${dir}/`;

  const baseTag = `<base href="${baseHref}">`;

  // Fix for <base> breaking hash/anchor links (#section).
  // With <base>, clicking <a href="#work"> navigates to baseHref#work (a full
  // page load) instead of scrolling in-place. This script intercepts hash-only
  // link clicks and performs in-page scroll navigation instead.
  const hashFixScript = `<script>(function(){document.addEventListener("click",function(e){var a=e.target.closest("a[href^='#']");if(!a)return;e.preventDefault();var h=a.getAttribute("href");var id=h.slice(1);if(id){var el=document.getElementById(id)||document.querySelector("[name='"+id+"']");if(el){el.scrollIntoView({behavior:"smooth",block:"start"});history.replaceState(null,"",h);return;}}window.location.hash=h;});})();</script>`;

  const injection = `${baseTag}\n  ${hashFixScript}`;

  // Insert right after <head> if present, else right after <html>, else prepend
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/(<head(\s[^>]*)?>)/i, `$1\n  ${injection}`);
  }
  if (/<html(\s[^>]*)?>/i.test(html)) {
    return html.replace(/(<html(\s[^>]*)?>)/i, `$1\n${injection}`);
  }
  // No head/html tag at all (fragment) — prepend the base tag
  return `${injection}\n${html}`;
}

function serveFile(absPath, baseUrl, injectBaseTag = false) {
  try {
    if (!isAllowed(absPath)) {
      return new Response(`Forbidden path. Allowed roots: ${ALLOWED_ROOTS.join(", ")}`, {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
      });
    }
    if (!fs.existsSync(absPath)) {
      return new Response(`Not found: ${absPath}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
      });
    }
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      // Auto-index: try index.html / index.htm
      // Always inject <base> for auto-indexed HTML — the visitor navigated to a
      // directory URL (e.g. from a hash link or direct access) and relative
      // asset paths (CSS, JS, images) need to resolve through /abs/.
      const indexHtml = path.join(absPath, "index.html");
      const indexHtm = path.join(absPath, "index.htm");
      if (fs.existsSync(indexHtml)) return serveFile(indexHtml, baseUrl, /* injectBase= */ true);
      if (fs.existsSync(indexHtm)) return serveFile(indexHtm, baseUrl, /* injectBase= */ true);
      return new Response(`Directory listing not supported. No index.html found in ${absPath}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
      });
    }
    if (!stat.isFile()) {
      return new Response(`Not a file: ${absPath}`, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
      });
    }

    const mime = getMime(absPath);

    // For HTML files loaded via /open?path=, inject a <base> tag so relative
    // asset references (CSS, JS, images) resolve through the /abs/ route.
    if (injectBaseTag && isHtml(absPath)) {
      const raw = fs.readFileSync(absPath, "utf-8");
      const patched = injectBase(raw, absPath, baseUrl);
      return new Response(patched, {
        headers: { "Content-Type": mime, ...corsHeaders },
      });
    }

    const data = fs.readFileSync(absPath);
    return new Response(data, {
      headers: { "Content-Type": mime, ...corsHeaders },
    });
  } catch (e) {
    return new Response(`Read error: ${e?.message || String(e)}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
    });
  }
}

function buildHelpHtml(baseUrl) {
  const roots = ALLOWED_ROOTS.map((root) => `<li><code>${root}</code></li>`).join("");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Static Web Server</title>
    <style>
      body { font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 2rem; color: #111827; }
      code { background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
      .muted { color: #6b7280; }
      .box { border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1rem 1.25rem; margin-bottom: 1rem; }
      ul { margin-top: 0.5rem; }
      li { margin-bottom: 0.25rem; }
    </style>
  </head>
  <body>
    <h1>Static Web Server (always on)</h1>
    <p class="muted">Serve any HTML file with full relative-asset support (CSS, JS, images, fonts…).</p>
    <div class="box">
      <h2>Usage</h2>
      <ul>
        <li>Entry point (injects &lt;base&gt; for relative assets):
          <code>${baseUrl}/open?path=/workspace/project/index.html</code></li>
        <li>Direct asset path: <code>${baseUrl}/abs/workspace/project/style.css</code></li>
        <li>Health check: <code>${baseUrl}/health</code></li>
      </ul>
    </div>
    <div class="box">
      <h2>How relative assets work</h2>
      <p>When you open a file via <code>/open?path=…</code>, the server injects a
      <code>&lt;base href="${baseUrl}/abs/path/to/dir/"&gt;</code> tag so the browser
      resolves <code>./style.css</code>, <code>../images/logo.png</code>, etc. through
      this server automatically — no changes to your HTML required.</p>
    </div>
    <div class="box">
      <h2>Allowed roots</h2>
      <ul>${roots}</ul>
    </div>
  </body>
</html>`;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const baseUrl = resolvePublicBaseUrl(req, url);
    const pathname = decodeURIComponent(url.pathname);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", port: PORT }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Root — help page
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(buildHelpHtml(baseUrl), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }

    // /open?path=/abs/path/to/file  — entry-point loader
    // Injects <base> tag so all relative assets resolve through /abs/
    if (pathname === "/open") {
      const p = url.searchParams.get("path");
      const absPath = toAbsPath(p || "");
      if (!absPath) {
        return new Response("Missing or invalid ?path=/absolute/file", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
        });
      }
      return serveFile(absPath, baseUrl, /* injectBase= */ true);
    }

    // /abs/workspace/project/style.css  — direct asset serving (no base injection)
    // This is what the browser uses for all relative URLs after <base> is injected.
    if (pathname.startsWith("/abs/")) {
      const rawPath = "/" + pathname.slice("/abs/".length);
      const absPath = toAbsPath(rawPath);
      if (!absPath) {
        return new Response("Invalid absolute path", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
        });
      }
      return serveFile(absPath, baseUrl, /* injectBase= */ false);
    }

    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
    });
  },
});

console.log(`[static-web] Ready at http://0.0.0.0:${PORT}`);
console.log(`[static-web]   /open?path=/workspace/project/index.html  (entry point, injects <base>)`);
console.log(`[static-web]   /abs/workspace/project/style.css           (asset serving)`);
console.log(`[static-web]   /health                                    (health check)`);
