/**
 * Your app — the thing the world sees.
 *
 * This is a tiny serverless web app: one `fetch` handler that returns a
 * response for every request. Kortix deploys it to a free `*.style.dev` URL
 * (see the `[[apps]]` block in ../kortix.toml). Edit this file — or just ask
 * your agent to build it out — then redeploy from the Apps panel.
 *
 * It's plain web-standard JavaScript: `fetch(request)` in, `Response` out. No
 * framework required. Add routes by branching on `new URL(request.url)`.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Your Kortix app is live</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: #ededed;
      background: radial-gradient(120% 120% at 50% 0%, #1a1a1f 0%, #0a0a0c 60%);
      padding: 2rem;
    }
    main { max-width: 540px; text-align: center; }
    .badge {
      display: inline-flex; align-items: center; gap: .5rem;
      padding: .35rem .75rem; border-radius: 999px;
      background: rgba(52, 211, 153, .12); color: #34d399;
      font-size: .8rem; font-weight: 600; letter-spacing: .01em;
      margin-bottom: 1.5rem;
    }
    .dot { width: .5rem; height: .5rem; border-radius: 999px; background: #34d399; }
    h1 { font-size: 2rem; font-weight: 650; letter-spacing: -.02em; margin-bottom: .75rem; }
    p { color: #a1a1aa; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: rgba(255,255,255,.06); padding: .15rem .4rem;
      border-radius: 6px; font-size: .9em; color: #e4e4e7;
    }
    .card {
      margin-top: 2rem; padding: 1.25rem 1.5rem; text-align: left;
      border: 1px solid rgba(255,255,255,.08); border-radius: 14px;
      background: rgba(255,255,255,.02);
    }
    .card p { font-size: .9rem; }
    .card p + p { margin-top: .5rem; }
  </style>
</head>
<body>
  <main>
    <span class="badge"><span class="dot"></span>Live on Kortix</span>
    <h1>Your app is running.</h1>
    <p>This page is served by <code>app/index.js</code> in your project.</p>
    <div class="card">
      <p>✏️&nbsp; Edit <code>app/index.js</code> to change what shows up here.</p>
      <p>🤖&nbsp; Or ask your agent: <em>“turn this into a landing page for …”</em></p>
      <p>🚀&nbsp; Then hit <strong>Deploy</strong> in the Apps panel to ship it.</p>
    </div>
  </main>
</body>
</html>`;

export default {
  fetch() {
    return new Response(PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
