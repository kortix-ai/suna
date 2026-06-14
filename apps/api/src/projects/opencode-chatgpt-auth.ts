import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The OpenAI Codex login is an OAuth 2.0 device grant: `authorize` returns a
// verification URL + short user code, and `callback` then LONG-POLLS OpenAI's
// token endpoint until the user finishes in the browser. Both calls hit a
// private `opencode serve` subprocess that holds the device code + the poll
// loop in its own memory — so the entire flow MUST run inside a single API
// request on a single replica. (The old start/complete split kept the job in a
// per-process Map and broke the instant `complete` load-balanced to a different
// pod — "ChatGPT authorization session expired" on ~2/3 of attempts in prod.)

export type ChatGptChallenge = {
  /** Verification URL the user opens (https://auth.openai.com/codex/device). */
  url: string;
  /** Raw instruction text from opencode, e.g. "Enter code: MN3B-DIF51". */
  instructions: string;
  /** The short user code parsed out of `instructions`, when present. */
  code: string | null;
};

function opencodeBin(): string {
  const here = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    resolve(process.cwd(), 'node_modules/.bin/opencode'),
    resolve(here, '../../node_modules/.bin/opencode'),
    resolve(process.cwd(), '../../node_modules/.bin/opencode'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error('OpenCode CLI is not installed in the API runtime');
  }
  return found;
}

function randomPort(): number {
  return 38_000 + Math.floor(Math.random() * 20_000);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(baseUrl: string, signal?: AbortSignal) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('ChatGPT authorization was cancelled');
    try {
      const res = await fetch(`${baseUrl}/provider/auth`, { signal });
      if (res.ok) return;
      lastError = new Error(`OpenCode auth endpoint returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('OpenCode did not become ready');
}

const USER_CODE_RE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/;

/**
 * Drives the OpenAI Codex device-auth flow end-to-end on THIS process and
 * returns the resulting `auth.json` (verbatim, as a string) for the caller to
 * persist as the project's `CODEX_AUTH_JSON` secret.
 *
 * Lifecycle, all on one replica:
 *   1. spawn a private, isolated `opencode serve`
 *   2. `authorize` → device challenge (url + user code); handed to `onChallenge`
 *   3. `callback` → blocks until the user authorizes in the browser
 *   4. read `auth.json` and return it
 *
 * `signal` (client disconnect and/or an overall timeout) aborts the in-flight
 * poll; the subprocess + temp HOME are always cleaned up.
 */
export async function runChatGptHeadlessAuth(input: {
  signal?: AbortSignal;
  onChallenge: (challenge: ChatGptChallenge) => void | Promise<void>;
}): Promise<string> {
  const { signal } = input;
  const home = mkdtempSync(join(tmpdir(), 'kortix-chatgpt-auth-'));
  const dataHome = join(home, '.local/share');
  const configHome = join(home, '.config');
  const cacheHome = join(home, '.cache');
  const authPath = join(dataHome, 'opencode/auth.json');
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const proc = Bun.spawn({
    cmd: [
      opencodeBin(),
      'serve',
      '--pure',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cacheHome,
      PORT: undefined,
      APP_PORT: undefined,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  try {
    await waitForReady(baseUrl, signal);

    const authRes = await fetch(`${baseUrl}/provider/openai/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 1 }),
      signal,
    });
    if (!authRes.ok) {
      throw new Error(`OpenCode headless auth failed to start (${authRes.status})`);
    }
    const auth = (await authRes.json()) as {
      url?: unknown;
      instructions?: unknown;
      method?: unknown;
    };
    if (auth.method !== 'auto' || typeof auth.url !== 'string') {
      throw new Error('OpenCode did not return a headless auth challenge');
    }
    const instructions = typeof auth.instructions === 'string' ? auth.instructions : '';
    const code = instructions.match(USER_CODE_RE)?.[0] ?? null;
    await input.onChallenge({ url: auth.url, instructions, code });

    // Blocks until the user completes the device authorization in the browser
    // (or `signal` aborts / times out). opencode polls OpenAI internally.
    const callbackRes = await fetch(`${baseUrl}/provider/openai/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 1 }),
      signal,
    });
    if (!callbackRes.ok) {
      const detail = await callbackRes.text().catch(() => '');
      throw new Error(detail || `OpenCode headless auth callback failed (${callbackRes.status})`);
    }
    const ok = await callbackRes.json().catch(() => null);
    if (ok !== true) {
      throw new Error('OpenCode did not confirm the ChatGPT authorization');
    }
    if (!existsSync(authPath)) {
      throw new Error(`OpenCode completed authorization but did not write ${authPath}`);
    }
    const parsed = JSON.parse(readFileSync(authPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OpenCode wrote invalid auth data');
    }
    return JSON.stringify(parsed, null, 2);
  } finally {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    rmSync(home, { recursive: true, force: true });
  }
}
