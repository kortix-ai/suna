/**
 * Hermetic `kortix` CLI subprocess fixture for ke2e.
 *
 * The CLI (apps/cli) is a Bun program. We invoke its SOURCE entry
 * (`apps/cli/src/index.ts`) via `bun run …` rather than the pre-built binary,
 * so a stale `dist/kortix` can never make the suite lie. Every invocation runs
 * in a throwaway temp cwd (so `init` / `create` / `ship` scaffold in isolation)
 * with a throwaway HOME + CLI config file, so login NEVER touches the real
 * `~/.config/kortix/config.json`.
 *
 * Discovered CLI env contract (apps/cli/src/api/config.ts + login.ts):
 *   - KORTIX_CONFIG_FILE  → the multi-host config path the CLI reads/writes.
 *     (KORTIX_AUTH_FILE is an accepted alias; we use KORTIX_CONFIG_FILE.) When
 *     this points anywhere other than the real default path, the CLI refuses to
 *     import the user's single-host auth.json — perfect test isolation.
 *   - KORTIX_DEFAULT_API_BASE → overrides the built-in `cloud` host URL, so a
 *     fresh config's active host points at the ke2e target. This is the API base
 *     EVERY command (login/whoami/ship) uses by default — no per-command --api
 *     needed. We feed it the ke2e origin WITHOUT the `/v1` suffix (the CLI's
 *     joinUrl re-adds exactly one `/v1`).
 *   - KORTIX_API_URL is read only as a *fallback* when the active host has no
 *     URL; since the seeded `cloud` host always carries a URL, it's shadowed —
 *     hence we drive the base via KORTIX_DEFAULT_API_BASE instead.
 *
 * The fixture is pure helpers (no ke2e flow plumbing) so flows stay declarative;
 * it returns the captured { exitCode, stdout, stderr } for the flow to assert on.
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadEnv } from "../core/env";

/** Repo root resolved from this file (tests/src/fixtures → ../../..). */
const REPO_ROOT = resolve(import.meta.dir, "../../..");
/** CLI source entry — invoked via `bun run` so a stale binary can't mislead. */
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.ts");

/** ke2e target origin without a trailing `/v1` (the CLI re-adds it). */
function targetApiBase(): string {
  return loadEnv().apiUrl.replace(/\/v1$/, "");
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Convenience: stdout + stderr joined (some CLI output goes to stderr). */
  all: string;
}

export interface CliRunOptions {
  /** Working directory for this invocation. Defaults to a fresh temp dir. */
  cwd?: string;
  /** Extra env vars (merged over the hermetic defaults). */
  env?: Record<string, string>;
  /** Per-invocation timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** stdin to feed the process (e.g. for prompts). Default: empty (EOF). */
  stdin?: string;
}

/**
 * A throwaway sandbox for CLI invocations: an isolated cwd + a private CLI
 * config file. Reuse one `CliSandbox` across the steps of a single flow so
 * `init` → `login` → `ship` see the same scaffold + the same logged-in config.
 */
export class CliSandbox {
  /** The isolated working directory (where scaffolds land). */
  readonly cwd: string;
  /** Private CLI config file path (KORTIX_CONFIG_FILE). */
  readonly configFile: string;
  /** Private HOME so nothing leaks to the real user dir. */
  readonly home: string;
  private disposed = false;

  constructor(label = "cli") {
    const root = mkdtempSync(join(tmpdir(), `ke2e-${label}-`));
    this.home = join(root, "home");
    this.cwd = join(root, "work");
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    this.configFile = join(this.home, ".config", "kortix", "config.json");
  }

  /** The hermetic env every invocation runs under. */
  baseEnv(): Record<string, string> {
    return {
      // Pass through PATH (git + bun must resolve) and a few innocuous vars.
      PATH: process.env.PATH ?? "",
      HOME: this.home,
      // Make the CLI deterministic + non-interactive-friendly.
      KORTIX_CONFIG_FILE: this.configFile,
      KORTIX_DEFAULT_API_BASE: targetApiBase(),
      // A stable git identity so `create`/`ship` commits don't fail on a
      // machine without a configured user.
      GIT_AUTHOR_NAME: "ke2e",
      GIT_AUTHOR_EMAIL: "ke2e@kortix.test",
      GIT_COMMITTER_NAME: "ke2e",
      GIT_COMMITTER_EMAIL: "ke2e@kortix.test",
      // Force non-TTY so prompt-driven branches take their headless path.
      CI: "1",
    };
  }

  /** Read the parsed CLI config JSON (or null if not written yet). */
  readConfig(): any | null {
    if (!existsSync(this.configFile)) return null;
    try {
      return JSON.parse(readFileSync(this.configFile, "utf8"));
    } catch {
      return null;
    }
  }

  /** True when the active host carries a token (i.e. logged in). */
  isLoggedIn(): boolean {
    const cfg = this.readConfig();
    const host = cfg?.hosts?.[cfg?.active];
    return typeof host?.token === "string" && host.token.length > 0;
  }

  /** Read a scaffolded file relative to the sandbox cwd. */
  readFile(rel: string): string {
    return readFileSync(join(this.cwd, rel), "utf8");
  }

  /** Whether a path (file or dir) exists relative to the sandbox cwd. */
  exists(rel: string): boolean {
    return existsSync(join(this.cwd, rel));
  }

  /** Write a file relative to the sandbox cwd (e.g. to set up a fixture state). */
  writeFile(rel: string, content: string): void {
    const p = join(this.cwd, rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf8");
  }

  /** Run the CLI with the given argv. Captures exit code + decoded streams. */
  async run(args: string[], opts: CliRunOptions = {}): Promise<CliResult> {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
      cwd: opts.cwd ?? this.cwd,
      env: { ...this.baseEnv(), ...(opts.env ?? {}) },
      stdin: opts.stdin != null ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = opts.timeoutMs ?? 60_000;
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);

    return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` };
  }

  /**
   * Seed a logged-in config by running the real `kortix login --token <pat>`
   * against the ke2e target. The PAT is validated by the API (`GET /accounts/me`)
   * and the resulting host record (token mode 0600) is what whoami/logout/ship
   * read. Returns the login result so callers can assert on it (LOGIN-1).
   *
   * Mint `pat` as OWNER via `ctx.fixtures.pat()` (POST /v1/accounts/tokens) and
   * pass the returned `kortix_pat_…` secret here.
   */
  async login(pat: string): Promise<CliResult> {
    return this.run(["login", "--token", pat]);
  }

  /** Tear down the temp dirs. Best-effort; safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      rmSync(resolve(this.home, ".."), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Sugar: make a sandbox, run a single command, dispose, return the result. */
export async function runCliOnce(args: string[], opts?: CliRunOptions): Promise<CliResult> {
  const sb = new CliSandbox();
  try {
    return await sb.run(args, opts);
  } finally {
    sb.dispose();
  }
}

/**
 * Drive the CLI's browser-callback login flow (LOGIN-2) WITHOUT a browser.
 *
 * `kortix login` (no --token) stands up a one-shot loopback callback server and
 * prints its URL — `…/cli/authorize?callback=http://127.0.0.1:<port>/callback&state=<hex>`
 * — to stdout, then tries to open a browser (harmless here). The dashboard's
 * only job is to POST `{state, token}` to that callback; we simulate the
 * dashboard by parsing the URL, then POSTing the (already-minted) PAT. The CLI
 * then verifies it via GET /accounts/me and saves the host. Returns the login
 * result once the process exits.
 */
export async function browserLogin(
  sb: CliSandbox,
  pat: string,
  opts: { badState?: boolean } = {},
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "login"], {
    cwd: sb.cwd,
    env: { ...sb.baseEnv() },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let stdoutBuf = "";
  let callbackUrl: string | null = null;
  let state: string | null = null;
  let port: string | null = null;

  // Read stdout incrementally until we see the authorize URL (or the stream ends).
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (value) stdoutBuf += decoder.decode(value, { stream: true });
    const m = stdoutBuf.match(/callback=([^&\s]+)&state=([0-9a-f]+)/i);
    if (m) {
      callbackUrl = decodeURIComponent(m[1]);
      state = m[2];
      const pm = callbackUrl.match(/:(\d+)\//);
      port = pm ? pm[1] : null;
      break;
    }
    if (done) break;
  }

  if (callbackUrl && port && state) {
    // Simulate the dashboard POSTing the minted token to the loopback callback.
    try {
      await fetch(`http://127.0.0.1:${port}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: opts.badState ? `${state}-wrong` : state, token: pat }),
      });
    } catch {
      /* the CLI will time out → non-zero exit, asserted by caller */
    }
  }

  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* gone */
    }
  }, 15_000);
  // Drain the rest of stdout from the SAME reader — the stream is already
  // locked by getReader() above, so re-wrapping proc.stdout would throw
  // "ReadableStream has already been used".
  let restStdout = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) restStdout += decoder.decode(value, { stream: true });
      if (done) break;
    }
  } catch {
    /* stream closed when the process was killed */
  }
  reader.releaseLock();
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);

  const stdout = stdoutBuf + restStdout;
  return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` };
}
