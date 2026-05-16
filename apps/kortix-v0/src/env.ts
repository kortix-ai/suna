import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  host: string;
  port: number;
  idleTimeout: number;
  githubToken: string | null;
  daytonaApiKey: string | null;
  daytonaApiUrl: string | null;
  daytonaTarget: string | null;
  sandboxVersion: string;
  daytonaImage: string;
  daytonaSnapshot: string | null;
  openCodeModel: string | null;
  openCodeStartCommand: string;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const idx = trimmed.indexOf("=");
  if (idx <= 0) return null;
  const key = trimmed.slice(0, idx).trim();
  let value = trimmed.slice(idx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

let loaded = false;
let ghTokenCache: string | null | undefined;

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findWorkspaceRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml")) || existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function loadDefaultEnv(): void {
  if (loaded) return;
  loaded = true;
  const root = findWorkspaceRoot(process.cwd());
  loadEnvFile(resolve(root, ".env"));
  loadEnvFile(resolve(root, "apps/api/.env"));
  loadEnvFile(resolve(root, "apps/kortix-v0/.env"));
}

function gitShortSha(root: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short=8", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const sha = new TextDecoder().decode(proc.stdout).trim();
    return sha || null;
  } catch {
    return null;
  }
}

function ghAuthToken(): string | null {
  if (ghTokenCache !== undefined) return ghTokenCache;
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    if (proc.exitCode !== 0) {
      ghTokenCache = null;
      return ghTokenCache;
    }
    const token = new TextDecoder().decode(proc.stdout).trim();
    ghTokenCache = token || null;
    return ghTokenCache;
  } catch {
    ghTokenCache = null;
    return ghTokenCache;
  }
}

export function getConfig(): AppConfig {
  loadDefaultEnv();
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const rootDir = resolve(process.env.KORTIX_V0_ROOT || workspaceRoot);
  const explicitDataDir = process.env.KORTIX_V0_DATA_DIR;
  const dataDir = explicitDataDir ? resolve(appRoot, explicitDataDir) : resolve(appRoot, ".local");
  const githubToken = process.env.KORTIX_GITHUB_TOKEN
    || process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_PAT
    || process.env.GITHUB_ACCESS_TOKEN
    || ghAuthToken()
    || null;
  const sandboxVersion = process.env.SANDBOX_VERSION
    || process.env.KORTIX_SANDBOX_VERSION
    || `dev-${gitShortSha(rootDir) || "latest"}`;
  const daytonaImage = process.env.DAYTONA_IMAGE || "kortix/computer:dev-latest";
  const snapshotPrefix = process.env.KORTIX_V0_SNAPSHOT_PREFIX || "kortix-sandbox";
  const snapshotEntrypointVersion = process.env.KORTIX_V0_ENTRYPOINT_VERSION || "daemon-v4-fast";
  const daytonaSnapshot = process.env.DAYTONA_SNAPSHOT
    || (sandboxVersion && sandboxVersion !== "unknown" ? `${snapshotPrefix}-v${sandboxVersion}-${snapshotEntrypointVersion}-poc` : null);
  const openCodeModel = process.env.KORTIX_V0_MODEL || null;
  mkdirSync(dataDir, { recursive: true });
  return {
    rootDir,
    dataDir,
    host: process.env.KORTIX_V0_HOST || "127.0.0.1",
    port: Number(process.env.KORTIX_V0_PORT || 4310),
    idleTimeout: Number(process.env.KORTIX_V0_IDLE_TIMEOUT || 60),
    githubToken,
    daytonaApiKey: process.env.DAYTONA_API_KEY || null,
    daytonaApiUrl: process.env.DAYTONA_SERVER_URL || process.env.DAYTONA_API_URL || null,
    daytonaTarget: process.env.DAYTONA_TARGET || null,
    sandboxVersion,
    daytonaImage,
    daytonaSnapshot,
    openCodeModel,
    openCodeStartCommand: process.env.KORTIX_V0_OPENCODE_START || [
      "bash -lc 'cd /workspace &&",
      "if command -v opencode-kortix >/dev/null 2>&1; then",
      "opencode-kortix serve --port 4096;",
      "elif command -v opencode >/dev/null 2>&1; then",
      "opencode serve --port 4096;",
      "else echo \"opencode binary missing\"; sleep 3600; fi'",
    ].join(" "),
  };
}

export function publicConfig() {
  const cfg = getConfig();
  return {
    repoTokenConfigured: Boolean(cfg.githubToken),
    daytonaConfigured: Boolean(cfg.daytonaApiKey && cfg.daytonaSnapshot),
    daytonaSnapshot: cfg.daytonaSnapshot,
    daytonaImage: cfg.daytonaImage,
    sandboxVersion: cfg.sandboxVersion,
    openCodeModel: cfg.openCodeModel,
    host: cfg.host,
    port: cfg.port,
    url: `http://${cfg.host}:${cfg.port}`,
  };
}
