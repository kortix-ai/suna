// The easiest possible GitHub setup for a self-hoster: create a brand-new
// GitHub App **owned by their org** (via the manifest flow), let them install
// it on the repo(s) they choose, and wire the resulting credentials into the
// instance `.env` — no personal-access-token as the primary path.
//
// Reference: "Creating a GitHub App from a manifest"
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//
// This module is split in two:
//   - pure functions (manifest/URL construction, PEM escaping, callback
//     parsing, env-patch construction, HTML rendering) — fully unit-testable,
//     no filesystem/network/process access.
//   - `runConnectGithubFlow`, the live orchestration: spins up a local
//     node:http server for the manifest-flow callbacks, opens (or prints) the
//     right URLs, exchanges the manifest code, and calls back into
//     caller-supplied `persist`/`print`/`openBrowser` hooks so the actual
//     file/process side effects stay owned by commands/self-host.ts. This
//     half can't be meaningfully unit-tested (it needs a real browser +
//     GitHub) — see the __tests__ file for what IS covered.

import { createServer } from 'node:http';
import { randomBytes, createSign } from 'node:crypto';
import * as readline from 'node:readline';

// ── Pure: manifest + URLs ────────────────────────────────────────────────────

export interface GitHubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  hook_attributes: { url: string; active: boolean };
}

/** "Kortix Self-Host <suffix>" — the suffix keeps the name globally unique on
 *  GitHub (app names collide across ALL of GitHub, not just one org). */
export function generateAppName(randomSuffix: () => string = () => randomBytes(4).toString('hex')): string {
  return `Kortix Self-Host ${randomSuffix()}`;
}

/** CSRF-style nonce round-tripped through GitHub on the manifest-creation
 *  redirect — verified in `runConnectGithubFlow` before trusting the code. */
export function generateState(randomToken: () => string = () => randomBytes(16).toString('hex')): string {
  return randomToken();
}

export function buildAppManifest(opts: {
  appName: string;
  homepageUrl: string;
  port: number;
}): GitHubAppManifest {
  return {
    name: opts.appName,
    url: opts.homepageUrl,
    redirect_url: `http://127.0.0.1:${opts.port}/created`,
    setup_url: `http://127.0.0.1:${opts.port}/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      administration: 'write',
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    },
    default_events: [],
    // GitHub requires `url` inside hook_attributes when present (else the
    // manifest is rejected as "'url' wasn't supplied"). No webhooks here, so a
    // valid FQDN + active:false.
    hook_attributes: { url: opts.homepageUrl, active: false },
  };
}

/**
 * GitHub only accepts the manifest as a POST body — there is no GET-redirect
 * form of `apps/new` that carries one — so this is the *target* of the local
 * `/start` page's auto-submitting form, not something the CLI ever loads
 * directly. Org-owned apps live under `/organizations/<org>/settings/...`;
 * a personal account (blank/`.` org) uses the unscoped `/settings/...` path.
 */
export function buildCreateAppUrl(opts: { org?: string; state: string }): string {
  const org = opts.org?.trim();
  const base =
    org && org !== '.'
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : 'https://github.com/settings/apps/new';
  const url = new URL(base);
  url.searchParams.set('state', opts.state);
  return url.toString();
}

/** Where the operator picks which repo(s) to install the (now-created) App
 *  on — GitHub's native "Only select repositories" scoping happens here. */
export function buildInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

// ── Pure: PEM <-> .env escaping ──────────────────────────────────────────────

/** GitHub's manifest-conversion response returns the private key with real
 *  newlines; a `.env` value can't hold those, so persist it with literal
 *  `\n` escapes (mirrors `normalizeGitHubPrivateKey` on the API side, which
 *  un-escapes them back before use). */
export function pemToEnvEscaped(pem: string): string {
  return pem.trim().replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
}

// ── Pure: callback / paste-back parsing ──────────────────────────────────────

/**
 * Extract one query-string parameter from either a full callback URL
 * (`http://127.0.0.1:PORT/created?code=abc&state=xyz`), a bare query string
 * (`code=abc&state=xyz`), or — for the manual paste-back path where an
 * operator just copies the raw value — the bare value itself
 * (`abc`, no `=`/`&` at all).
 */
export function extractParam(input: string, param: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const qIndex = trimmed.indexOf('?');
  const query = qIndex >= 0 ? trimmed.slice(qIndex + 1) : trimmed.includes('=') ? trimmed : '';
  if (query) {
    const value = new URLSearchParams(query).get(param);
    if (value) return value;
  }

  // A bare pasted value has no query-string syntax at all — treat it as the
  // value itself rather than failing to find `param` in it.
  if (!trimmed.includes('=') && !trimmed.includes('&')) return trimmed;
  return null;
}

export interface CreatedCallback {
  code: string | null;
  state: string | null;
}

export function parseCreatedCallback(url: string): CreatedCallback {
  return { code: extractParam(url, 'code'), state: extractParam(url, 'state') };
}

export interface InstalledCallback {
  installationId: string | null;
  setupAction: string | null;
}

export function parseInstalledCallback(url: string): InstalledCallback {
  return { installationId: extractParam(url, 'installation_id'), setupAction: extractParam(url, 'setup_action') };
}

// ── Pure: env wiring ──────────────────────────────────────────────────────────

/**
 * Everything to persist the instant the manifest code is exchanged for real
 * App credentials — written immediately (before install even happens) so a
 * mid-flow abort doesn't lose the freshly-minted app. `KORTIX_GITHUB_APP_ID`
 * / `_PRIVATE_KEY` / `_SLUG` are the exact keys `apps/api/src/projects/github.ts`
 * reads; client id/secret/webhook secret aren't read by the API today but are
 * kept so the App can be managed later without regenerating it. The state
 * secret backs `KORTIX_GITHUB_APP_STATE_SECRET`-signed install links
 * (`buildGitHubAppInstallState`) — generated once, left alone if already set.
 */
export function buildAppCredentialsEnvPatch(opts: {
  appId: string;
  slug: string;
  privateKeyPem: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  currentStateSecret?: string;
  generateStateSecret?: () => string;
}): Record<string, string> {
  const patch: Record<string, string> = {
    KORTIX_GITHUB_APP_ID: opts.appId,
    KORTIX_GITHUB_APP_SLUG: opts.slug,
    KORTIX_GITHUB_APP_PRIVATE_KEY: pemToEnvEscaped(opts.privateKeyPem),
    KORTIX_GITHUB_APP_CLIENT_ID: opts.clientId,
    KORTIX_GITHUB_APP_CLIENT_SECRET: opts.clientSecret,
    KORTIX_GITHUB_APP_WEBHOOK_SECRET: opts.webhookSecret,
  };
  if (!opts.currentStateSecret?.trim()) {
    patch.KORTIX_GITHUB_APP_STATE_SECRET = (opts.generateStateSecret ?? (() => randomBytes(32).toString('hex')))();
  }
  return patch;
}

/**
 * The keys `apps/api/src/projects/git-backends/github.ts` reads to treat
 * managed git as configured via the App path — and the PAT-path keys it
 * clears so a stale token from a prior `configure` run can never silently
 * shadow the App the operator just connected.
 */
export function buildManagedGitEnvPatch(opts: { owner: string; installationId: string }): Record<string, string> {
  return {
    MANAGED_GIT_PROVIDER: 'github',
    MANAGED_GIT_GITHUB_OWNER: opts.owner,
    MANAGED_GIT_GITHUB_INSTALL_ID: opts.installationId,
    MANAGED_GIT_GITHUB_TOKEN: '',
    KORTIX_GITHUB_TOKEN: '',
    KORTIX_GITHUB_OWNER: opts.owner,
  };
}

// ── Pure: HTML ────────────────────────────────────────────────────────────────

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The intermediate local page GitHub's manifest flow requires: it POSTs the
 * manifest JSON to `createUrl` (github.com) — the only way to hand GitHub a
 * manifest is a same-navigation form POST, there's no GET-redirect form. Auto-
 * submits via a plain (no-JS-required) form; the `<script>` submit is just so
 * it happens without a click when JS is available.
 */
export function renderStartPageHtml(opts: { manifest: GitHubAppManifest; createUrl: string }): string {
  const manifestJson = escapeHtmlAttr(JSON.stringify(opts.manifest));
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Connecting Kortix to GitHub…</title></head>
<body>
<p>Redirecting to GitHub to create your Kortix GitHub App…</p>
<form id="kortix-github-manifest" method="post" action="${escapeHtmlAttr(opts.createUrl)}">
  <input type="hidden" name="manifest" value="${manifestJson}" />
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById('kortix-github-manifest').submit();</script>
</body>
</html>
`;
}

export function renderClosePageHtml(title: string, message: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtmlAttr(title)}</title></head>
<body>
<p>${escapeHtmlAttr(message)}</p>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>
`;
}

// ── Pure-ish: GitHub App JWT (signature depends on a real RSA key, but the
//    structure/claims are deterministic given `nowMs`) ───────────────────────

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** Same construction as the API's `createGitHubAppJwt` — needed here too so
 *  the CLI can resolve the installation's account login (for a personal-
 *  account install where there's no `--org`) without round-tripping through
 *  a running API. */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString('base64url');
  return `${unsigned}.${signature}`;
}

// ── Network: manifest exchange + installation lookup ─────────────────────────

export interface ManifestConversionResult {
  id: number;
  slug: string;
  pem: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
}

/** `POST /app-manifests/{code}/conversions` — the code is single-use and
 *  expires after 1 hour (GitHub's limit), so this must run promptly after
 *  the `/created` callback fires. */
export async function exchangeManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestConversionResult> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kortix-self-host-cli',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub manifest conversion failed (${res.status}): ${detail || res.statusText}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    id: Number(body.id),
    slug: String(body.slug ?? ''),
    pem: String(body.pem ?? ''),
    client_id: String(body.client_id ?? ''),
    client_secret: String(body.client_secret ?? ''),
    webhook_secret: String(body.webhook_secret ?? ''),
  };
}

/** Resolve the installation's account login/type — the real owner for a
 *  personal-account install (no `--org` given up front). Best-effort: a
 *  failure here falls back to whatever `--org` the operator already gave. */
export async function fetchAppInstallation(opts: {
  appId: string;
  privateKeyPem: string;
  installationId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ login: string | null; type: string | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const jwt = signAppJwt(opts.appId, opts.privateKeyPem);
  const res = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(opts.installationId)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'kortix-self-host-cli',
    },
  });
  if (!res.ok) return { login: null, type: null };
  const body = (await res.json()) as { account?: { login?: string; type?: string } };
  return { login: body.account?.login ?? null, type: body.account?.type ?? null };
}

// ── Live orchestration ───────────────────────────────────────────────────────

export interface CancelablePrompt {
  promise: Promise<string>;
  cancel: () => void;
}

/** A single-question readline prompt that can be abandoned once the local
 *  HTTP callback wins the race — used only in `--manual`/non-TTY mode. */
export function createPastePrompt(label: string): CancelablePrompt {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const promise = new Promise<string>((resolve) => {
    rl.question(`  ${label} (or press enter to keep waiting for the automatic callback): `, (answer) => resolve(answer));
  });
  return { promise, cancel: () => rl.close() };
}

export interface ConnectGithubDeps {
  /** GitHub org to create/install the App under; blank/`.`/undefined = the
   *  operator's personal account. */
  org?: string;
  /** Headless mode: don't try to open a local browser; print URLs + an SSH
   *  local-forward hint, and accept pasted-back code/installation_id. */
  manual: boolean;
  publicUrl: string;
  /** Current `KORTIX_GITHUB_APP_STATE_SECRET`, if any — only generate a new
   *  one when unset. */
  currentStateSecret?: string;
  /** Merge + persist an env patch immediately (before the rest of the flow
   *  continues) — so an aborted flow never loses a freshly-minted App. */
  persist: (patch: Record<string, string>) => void;
  openBrowser: (url: string) => void;
  print: (msg: string) => void;
  findFreePort: () => Promise<number>;
  fetchImpl?: typeof fetch;
  /** Only supplied in manual mode — races the local HTTP callback against an
   *  operator paste-back, whichever resolves first wins. */
  promptPaste?: (label: string) => CancelablePrompt;
}

export interface ConnectGithubResult {
  ok: boolean;
  owner?: string;
  installationId?: string;
  slug?: string;
  error?: string;
}

async function waitForCallback<T>(
  serverPromise: Promise<T>,
  pasteHandle: CancelablePrompt | undefined,
  parsePasted: (raw: string) => T,
): Promise<T> {
  if (!pasteHandle) return serverPromise;
  try {
    return await Promise.race([serverPromise, pasteHandle.promise.then(parsePasted)]);
  } finally {
    pasteHandle.cancel();
  }
}

/**
 * The end-to-end GitHub App manifest flow: spins up a local callback server,
 * walks the operator through create → install, exchanges credentials, and
 * calls `persist` with the exact env patches at each durable step. Returns
 * `{ ok: false, error }` instead of throwing so callers can print a clean
 * message — the only intentional throw path is the local server failing to
 * bind, which is genuinely exceptional.
 */
export async function runConnectGithubFlow(deps: ConnectGithubDeps): Promise<ConnectGithubResult> {
  const port = await deps.findFreePort();
  const state = generateState();
  const appName = generateAppName();
  const manifest = buildAppManifest({ appName, homepageUrl: deps.publicUrl || 'https://kortix.ai', port });
  const createUrl = buildCreateAppUrl({ org: deps.org, state });

  let resolveCreated: ((v: CreatedCallback) => void) | null = null;
  let resolveInstalled: ((v: InstalledCallback) => void) | null = null;
  const createdPromise = new Promise<CreatedCallback>((resolve) => {
    resolveCreated = resolve;
  });
  const installedPromise = new Promise<InstalledCallback>((resolve) => {
    resolveInstalled = resolve;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/start') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStartPageHtml({ manifest, createUrl }));
      return;
    }
    if (url.pathname === '/created') {
      const callback = parseCreatedCallback(url.search);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderClosePageHtml(
          'GitHub App created',
          callback.code ? 'Kortix received the app.' : 'Something went wrong — no code was returned.',
        ),
      );
      if (callback.code && resolveCreated) {
        resolveCreated(callback);
        resolveCreated = null;
      }
      return;
    }
    if (url.pathname === '/installed') {
      const callback = parseInstalledCallback(url.search);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderClosePageHtml(
          'GitHub App installed',
          callback.installationId
            ? 'Kortix received the installation.'
            : 'Something went wrong — no installation_id was returned.',
        ),
      );
      if (callback.installationId && resolveInstalled) {
        resolveInstalled(callback);
        resolveInstalled = null;
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  try {
    const startUrl = `http://127.0.0.1:${port}/start`;
    deps.print(`\n  Create the GitHub App: ${startUrl}`);
    if (deps.manual) {
      deps.print(`  Headless box? Forward the port from a machine with a browser:`);
      deps.print(`    ssh -L ${port}:127.0.0.1:${port} <user>@<this-host>`);
      deps.print(`  ...then open http://127.0.0.1:${port}/start there — GitHub will create a`);
      deps.print(`  pending app named "${appName}" and redirect back to this CLI.`);
    } else {
      deps.openBrowser(startUrl);
    }

    const created = await waitForCallback(
      createdPromise,
      deps.manual ? deps.promptPaste?.('Paste the "code" from the redirect URL after creating the App') : undefined,
      (pasted) => parseCreatedCallback(pasted),
    );
    if (!created.code) {
      return { ok: false, error: 'No authorization code received from GitHub — the App was not created.' };
    }
    if (created.state && created.state !== state) {
      return { ok: false, error: 'State mismatch on the GitHub App creation callback — aborting for safety.' };
    }

    deps.print('  Exchanging the manifest code for App credentials…');
    const conversion = await exchangeManifestCode(created.code, deps.fetchImpl);
    deps.persist(
      buildAppCredentialsEnvPatch({
        appId: String(conversion.id),
        slug: conversion.slug,
        privateKeyPem: conversion.pem,
        clientId: conversion.client_id,
        clientSecret: conversion.client_secret,
        webhookSecret: conversion.webhook_secret,
        currentStateSecret: deps.currentStateSecret,
      }),
    );
    deps.print(`  Created GitHub App "${appName}" (${conversion.slug}).`);

    const installUrl = buildInstallUrl(conversion.slug);
    deps.print(`\n  Install it on the repo(s) you want Kortix to manage: ${installUrl}`);
    deps.print(`  Pick "Only select repositories" to scope it to just one repo, or install on all.`);
    if (deps.manual) {
      deps.print(`  (Same port-forward as above works here too.)`);
    } else {
      deps.openBrowser(installUrl);
    }

    const installed = await waitForCallback(
      installedPromise,
      deps.manual ? deps.promptPaste?.('Paste the "installation_id" from the redirect URL after installing') : undefined,
      (pasted) => parseInstalledCallback(pasted),
    );
    if (!installed.installationId) {
      return { ok: false, error: 'No installation_id received from GitHub — install was not completed.' };
    }

    const installation = await fetchAppInstallation({
      appId: String(conversion.id),
      privateKeyPem: conversion.pem,
      installationId: installed.installationId,
      fetchImpl: deps.fetchImpl,
    });
    const owner = installation.login || deps.org?.trim() || '';
    if (!owner) {
      return { ok: false, error: 'Could not determine the GitHub owner/org for this installation.' };
    }

    deps.persist(buildManagedGitEnvPatch({ owner, installationId: installed.installationId }));
    deps.print(`  Installed on "${owner}" (installation ${installed.installationId}).`);

    return { ok: true, owner, installationId: installed.installationId, slug: conversion.slug };
  } finally {
    server.close();
  }
}
