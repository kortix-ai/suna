import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  generateSlackManifest,
  resolveBaseUrl,
  shouldIncludeOauthInManifest,
} from './slack-manifest';

export const manifestRoutes = new Hono<AppEnv>();

manifestRoutes.get('/manifest', (c) => {
  const baseUrl = resolveBaseUrl(new URL(c.req.url), c.req.query('base_url'));
  const manifest = generateSlackManifest({
    baseUrl,
    includeOauth: c.req.query('mode') === 'multi' || shouldIncludeOauthInManifest(),
  });
  return c.json(manifest);
});

manifestRoutes.get('/setup', (c) => {
  const baseUrl = resolveBaseUrl(new URL(c.req.url), c.req.query('base_url'));
  const multi = c.req.query('mode') === 'multi' || shouldIncludeOauthInManifest();
  const manifest = generateSlackManifest({ baseUrl, includeOauth: multi });
  const manifestJson = JSON.stringify(manifest, null, 2);
  const slackCreate = 'https://api.slack.com/apps?new_app=1';
  const eventUrl = `${baseUrl.replace(/\/$/, '')}/v1/webhooks/chat/slack`;
  const html = renderSetupPage({
    baseUrl,
    eventUrl,
    multi,
    manifestJson,
    slackCreate,
  });
  return c.html(html);
});

function renderSetupPage(input: {
  baseUrl: string;
  eventUrl: string;
  multi: boolean;
  manifestJson: string;
  slackCreate: string;
}): string {
  const mode = input.multi ? 'multi-tenant (OAuth)' : 'single-tenant';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Connect Slack — Kortix</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
:root { color-scheme: light dark; }
body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 760px; margin: 2.5rem auto; padding: 0 1.25rem; line-height: 1.55; }
h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.05rem; margin-top: 2rem; }
.subtle { color: #888; font-size: 0.9rem; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(127,127,127,0.15); font-size: 0.75rem; }
pre { background: rgba(127,127,127,0.1); border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; padding: 1rem; overflow: auto; max-height: 380px; font-size: 0.85rem; }
button, .btn { display: inline-block; background: #111; color: #fff; padding: 0.55rem 0.9rem; border-radius: 6px; border: 0; cursor: pointer; font: inherit; text-decoration: none; }
@media (prefers-color-scheme: dark) { button, .btn { background: #f5f5f5; color: #111; } }
input[type=text] { width: 100%; padding: 0.5rem 0.7rem; border-radius: 6px; border: 1px solid rgba(127,127,127,0.4); font: inherit; box-sizing: border-box; }
ol li { margin: 0.4rem 0; }
.row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
code { background: rgba(127,127,127,0.15); padding: 0 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Connect Slack</h1>
<p class="subtle">
  Auto-generates a Slack app manifest with every URL pointing at <code>${escapeHtml(input.baseUrl)}</code>.
  Current mode: <span class="pill">${escapeHtml(mode)}</span>
</p>

<h2>1. Pick the base URL</h2>
<p class="subtle">Detected. Override with your ngrok / cloudflared tunnel if needed, then regenerate.</p>
<form method="get" class="row" style="margin-bottom:0.75rem">
  <input name="base_url" type="text" value="${escapeHtml(input.baseUrl)}" placeholder="https://your-tunnel.ngrok-free.app" />
  ${input.multi ? '<input type="hidden" name="mode" value="multi" />' : ''}
  <button type="submit">Regenerate</button>
</form>

<h2>2. Copy this manifest</h2>
<div class="row" style="margin-bottom:0.5rem">
  <button id="copyBtn" type="button">Copy manifest JSON</button>
  <a class="btn" href="${input.slackCreate}" target="_blank" rel="noopener noreferrer">Open Slack — Create App</a>
</div>
<pre id="manifest">${escapeHtml(input.manifestJson)}</pre>

<h2>3. Paste it into Slack</h2>
<ol>
  <li>In the Slack tab you just opened, click <b>From a manifest</b>.</li>
  <li>Pick a workspace, then paste the JSON above and confirm.</li>
  <li>On the next page click <b>Install to Workspace</b>.</li>
  <li>From <b>OAuth &amp; Permissions</b>, copy the <b>Bot User OAuth Token</b> (<code>xoxb-…</code>).</li>
  <li>From <b>Basic Information</b>, copy the <b>Signing Secret</b>.</li>
  ${input.multi ? `<li>(Multi-tenant) Note the <b>Client ID</b> and <b>Client Secret</b> too.</li>` : ''}
</ol>

<h2>4. Put them in <code>apps/api/.env</code></h2>
<pre>${escapeHtml(envSnippet(input.multi))}</pre>

<h2>5. Restart the API and verify</h2>
<pre>curl ${escapeHtml(input.baseUrl)}/v1/webhooks/chat/health</pre>
<p class="subtle">Expect <code>configured: true</code> and <code>mode: ${input.multi ? 'multi' : 'single'}</code>.</p>
${input.multi ? `<h2>6. Install the bot via OAuth</h2><p>Visit <a href="${escapeHtml(input.baseUrl)}/v1/webhooks/chat/slack/install">${escapeHtml(input.baseUrl)}/v1/webhooks/chat/slack/install</a> to install the app into a workspace.</p>` : `<h2>6. Send a message</h2><p>In any channel you've invited the bot to, try: <code>@kortix help me plan something</code></p>`}

<script>
document.getElementById('copyBtn').addEventListener('click', async () => {
  const text = document.getElementById('manifest').textContent;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('copyBtn');
    const orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) { alert('Copy failed — select the text manually'); }
});
</script>
</body>
</html>`;
}

function envSnippet(multi: boolean): string {
  if (multi) {
    return [
      'KORTIX_CHANNELS_MODE=multi',
      'SLACK_SIGNING_SECRET=...',
      'SLACK_CLIENT_ID=...',
      'SLACK_CLIENT_SECRET=...',
      'SLACK_REDIRECT_URI=https://<your-tunnel>/v1/webhooks/chat/slack/oauth/callback',
    ].join('\n');
  }
  return [
    'KORTIX_CHANNELS_MODE=single',
    'SLACK_BOT_TOKEN=xoxb-...',
    'SLACK_SIGNING_SECRET=...',
    'SLACK_TEAM_ID=T...',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
