import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Job = {
  id: string;
  projectId: string;
  userId: string;
  proc: ReturnType<typeof Bun.spawn>;
  baseUrl: string;
  home: string;
  authPath: string;
  createdAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map<string, Job>();

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

async function waitForReady(baseUrl: string) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/provider/auth`);
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

function cleanupJob(job: Job) {
  jobs.delete(job.id);
  clearTimeout(job.timeout);
  try {
    job.proc.kill();
  } catch {
    // already exited
  }
  rmSync(job.home, { recursive: true, force: true });
}

export async function startChatGptHeadlessAuth(input: {
  projectId: string;
  userId: string;
}): Promise<{ authId: string; url: string; instructions: string; code: string | null }> {
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

  const authId = randomUUID();
  const job: Job = {
    id: authId,
    projectId: input.projectId,
    userId: input.userId,
    proc,
    baseUrl,
    home,
    authPath,
    createdAt: Date.now(),
    timeout: setTimeout(() => {
      const current = jobs.get(authId);
      if (current) cleanupJob(current);
    }, JOB_TTL_MS),
  };
  jobs.set(authId, job);

  try {
    await waitForReady(baseUrl);
    const authRes = await fetch(`${baseUrl}/provider/openai/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 1 }),
    });
    if (!authRes.ok) {
      throw new Error(`OpenCode headless auth failed to start (${authRes.status})`);
    }
    const auth = await authRes.json() as {
      url?: unknown;
      instructions?: unknown;
      method?: unknown;
    };
    if (auth.method !== 'auto' || typeof auth.url !== 'string') {
      throw new Error('OpenCode did not return a headless auth challenge');
    }
    const instructions = typeof auth.instructions === 'string' ? auth.instructions : '';
    const code = instructions.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.[0] ?? null;
    return {
      authId,
      url: auth.url,
      instructions,
      code,
    };
  } catch (err) {
    cleanupJob(job);
    throw err;
  }
}

export async function completeChatGptHeadlessAuth(input: {
  authId: string;
  projectId: string;
  userId: string;
}): Promise<string> {
  const job = jobs.get(input.authId);
  if (!job || job.projectId !== input.projectId || job.userId !== input.userId) {
    throw new Error('ChatGPT authorization session expired. Start the connection again.');
  }

  try {
    const callbackRes = await fetch(`${job.baseUrl}/provider/openai/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 1 }),
    });
    if (!callbackRes.ok) {
      const detail = await callbackRes.text().catch(() => '');
      throw new Error(detail || `OpenCode headless auth callback failed (${callbackRes.status})`);
    }
    const ok = await callbackRes.json().catch(() => null);
    if (ok !== true) {
      throw new Error('OpenCode did not confirm the ChatGPT authorization');
    }
    if (!existsSync(job.authPath)) {
      throw new Error(`OpenCode completed authorization but did not write ${job.authPath}`);
    }
    const authJson = readFileSync(job.authPath, 'utf8');
    const parsed = JSON.parse(authJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OpenCode wrote invalid auth data');
    }
    return JSON.stringify(parsed, null, 2);
  } finally {
    cleanupJob(job);
  }
}
