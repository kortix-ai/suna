import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, dirname, resolve } from "path";

export type ServiceAdapter = "spawn" | "s6";
export type ServiceScope = "bootstrap" | "core" | "project" | "session";
export type ServiceStatus =
  | "starting"
  | "running"
  | "stopped"
  | "failed"
  | "backoff";
export type ServiceRestartPolicy = "always" | "on-failure" | "never";
export type ServiceHealthType = "none" | "tcp" | "http";

export interface ServiceHealthCheck {
  type: ServiceHealthType;
  path?: string;
  timeoutMs?: number;
}

export interface RegisteredServiceSpec {
  id: string;
  name: string;
  adapter: ServiceAdapter;
  scope: ServiceScope;
  description?: string;
  builtin: boolean;
  userVisible: boolean;
  projectId?: string | null;
  template?: string | null;
  framework?: string | null;
  sourcePath?: string | null;
  sourceType?: "git" | "code" | "files" | "tar";
  sourceRef?: string | null;
  startCommand?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  envVarKeys: string[];
  deps: string[];
  port?: number | null;
  desiredState: "running" | "stopped";
  autoStart: boolean;
  restartPolicy: ServiceRestartPolicy;
  restartDelayMs: number;
  s6ServiceName?: string | null;
  processPatterns: string[];
  healthCheck: ServiceHealthCheck;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceStateSnapshot {
  id: string;
  name: string;
  adapter: ServiceAdapter;
  scope: ServiceScope;
  status: ServiceStatus;
  desiredState: "running" | "stopped";
  builtin: boolean;
  userVisible: boolean;
  pid: number | null;
  port: number | null;
  framework: string | null;
  sourcePath: string | null;
  projectId: string | null;
  template: string | null;
  autoStart: boolean;
  restarts: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
  managed: true;
}

interface ManagedService {
  spec: RegisteredServiceSpec;
  proc: Bun.Subprocess<any, any, any> | null;
  state: ServiceStateSnapshot;
  intentionallyStopped: boolean;
  startupPromise: Promise<ServiceActionResult> | null;
}

interface ServiceRegistryFile {
  version: number;
  services: RegisteredServiceSpec[];
}

interface FrameworkCommands {
  install: string | null;
  build: string | null;
  start: string;
}

export interface LegacyDeploymentConfig {
  deploymentId: string;
  sourceType: "git" | "code" | "files" | "tar";
  sourceRef?: string;
  sourcePath: string;
  framework?: string;
  envVarKeys?: string[];
  buildConfig?: Record<string, unknown>;
  entrypoint?: string;
}

export interface DeployResult {
  success: boolean;
  service?: ServiceStateSnapshot;
  port?: number;
  pid?: number;
  framework?: string;
  error?: string;
  logs: string[];
  buildDuration?: number;
  startDuration?: number;
}

export interface ServiceActionResult {
  ok: boolean;
  output: string;
  service?: ServiceStateSnapshot;
}

export interface RegisterServiceInput {
  id: string;
  name?: string;
  adapter?: ServiceAdapter;
  scope?: ServiceScope;
  description?: string;
  projectId?: string | null;
  template?: string | null;
  framework?: string | null;
  sourcePath?: string | null;
  startCommand?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  envVarKeys?: string[];
  deps?: string[];
  port?: number | null;
  desiredState?: "running" | "stopped";
  autoStart?: boolean;
  restartPolicy?: ServiceRestartPolicy;
  restartDelayMs?: number;
  s6ServiceName?: string | null;
  processPatterns?: string[];
  userVisible?: boolean;
  healthCheck?: Partial<ServiceHealthCheck>;
}

export interface ServiceTemplate {
  id: string;
  name: string;
  description: string;
  adapter: ServiceAdapter;
  framework?: string;
  startCommand?: string;
  installCommand?: string | null;
  buildCommand?: string | null;
  defaultPort?: number;
}

const REGISTRY_VERSION = 1;
const WORKSPACE_ROOT = process.env.KORTIX_WORKSPACE || "/workspace";
const SERVICE_STATE_DIR = join(WORKSPACE_ROOT, ".kortix", "services");
const REGISTRY_FILE = join(SERVICE_STATE_DIR, "registry.json");
const LOG_DIR = join(SERVICE_STATE_DIR, "logs");

const INSTALL_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 120_000;
const START_WAIT_MS = 30_000; // Must cover run-opencode-serve.sh waits (~20s worst case) + startup
const WATCHDOG_INTERVAL_MS = Number(
  process.env.KORTIX_SERVICE_WATCHDOG_INTERVAL_MS || 5_000,
);
const RECOVERY_THROTTLE_MS = Number(
  process.env.KORTIX_SERVICE_RECOVERY_THROTTLE_MS || 4_000,
);
const PORT_MIN = 10_000;
const PORT_MAX = 60_000;
const PERSISTED_SOURCE_ROOT = WORKSPACE_ROOT;
const ECONNRESET_GUARD_PATH = "/ephemeral/kortix-master/econnreset-guard.cjs";
const INNER_DOCKER_ENABLED = process.env.KORTIX_ENABLE_INNER_DOCKER !== "0";

function s6svc(
  id: string,
  name: string,
  scope: ServiceScope,
  s6Name: string,
  opts: Partial<RegisteredServiceSpec> = {},
): RegisteredServiceSpec {
  const { healthCheck, ...restOpts } = opts;
  const defaultHealthCheck: ServiceHealthCheck = healthCheck
    ? { ...healthCheck }
    : opts.port
      ? { type: "tcp", timeoutMs: 2000 }
      : { type: "none" };

  return {
    id,
    name,
    adapter: "s6",
    scope,
    description: "",
    builtin: true,
    userVisible: false,
    projectId: null,
    template: id,
    framework: null,
    sourcePath: null,
    sourceType: "files",
    sourceRef: null,
    startCommand: null,
    installCommand: null,
    buildCommand: null,
    envVarKeys: [],
    deps: [],
    port: null,
    desiredState: "running",
    autoStart: true,
    restartPolicy: "always",
    restartDelayMs: 2000,
    s6ServiceName: s6Name,
    processPatterns: [],
    healthCheck: defaultHealthCheck,
    createdAt: "",
    updatedAt: "",
    ...restOpts,
  };
}

const BUILTIN_SERVICES: RegisteredServiceSpec[] = [
  // opencode-serve is spawn — managed directly by Kortix Master (not s6)
  {
    id: "opencode-serve",
    name: "Agent Runtime API",
    adapter: "spawn",
    scope: "core",
    description: "",
    builtin: true,
    userVisible: false,
    projectId: null,
    template: "opencode-serve",
    framework: "node",
    sourcePath: WORKSPACE_ROOT,
    sourceType: "files",
    sourceRef: null,
    startCommand: "bash /ephemeral/kortix-master/scripts/run-opencode-serve.sh",
    installCommand: null,
    buildCommand: null,
    envVarKeys: [],
    deps: [],
    port: 4096,
    desiredState: "running",
    autoStart: true,
    restartPolicy: "always",
    restartDelayMs: 3000,
    s6ServiceName: null,
    processPatterns: ["opencode serve --port 4096"],
    healthCheck: { type: "tcp", timeoutMs: 2000 },
    createdAt: "",
    updatedAt: "",
  },
  // All other system services: s6 supervised, controlled via s6-svc
  s6svc("chromium-persistent", "Chromium", "core", "svc-chromium-persistent", {
    port: 9222,
    processPatterns: ["chromium-browser"],
    healthCheck: { type: "tcp", timeoutMs: 1500 },
  }),
  s6svc(
    "agent-browser-session",
    "Agent Browser Session",
    "core",
    "svc-agent-browser-session",
    {
      deps: ["chromium-persistent"],
      processPatterns: ["agent-browser-session"],
    },
  ),
  s6svc(
    "agent-browser-viewer",
    "Agent Browser Viewer",
    "core",
    "svc-agent-browser-viewer",
    {
      port: 9224,
      processPatterns: ["agent-browser-viewer.js"],
      healthCheck: { type: "tcp", timeoutMs: 1500 },
    },
  ),
  s6svc("static-web", "Static Web Server", "core", "svc-static-web", {
    port: 3211,
    processPatterns: ["static-web.js"],
    healthCheck: { type: "tcp", timeoutMs: 1500 },
  }),
  s6svc("lss-sync", "LSS Sync", "core", "svc-lss-sync", {
    envVarKeys: ["OPENAI_API_KEY"],
    processPatterns: ["lss-sync"],
  }),
  s6svc("sshd", "SSH Daemon", "bootstrap", "svc-sshd", {
    port: 22,
    processPatterns: ["sshd -D"],
    healthCheck: { type: "none" },
  }),
  ...(INNER_DOCKER_ENABLED
    ? [
        s6svc("docker", "Docker Daemon", "bootstrap", "svc-docker", {
          processPatterns: ["dockerd"],
        }),
      ]
    : []),
];

const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    id: "custom-command",
    name: "Custom command",
    description: "Run any custom command from a project directory",
    adapter: "spawn",
  },
  {
    id: "nextjs",
    name: "Next.js app",
    description: "Install, build, and start a Next.js application",
    adapter: "spawn",
    framework: "nextjs",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm start",
    defaultPort: 3000,
  },
  {
    id: "vite",
    name: "Vite app",
    description: "Install, build, and preview a Vite application",
    adapter: "spawn",
    framework: "vite",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npx vite preview --host 0.0.0.0 --port __PORT__",
    defaultPort: 4173,
  },
  {
    id: "node",
    name: "Node app",
    description: "Install and start a Node/Bun application",
    adapter: "spawn",
    framework: "node",
    installCommand: "npm install",
    buildCommand: null,
    startCommand: "npm start",
    defaultPort: 3000,
  },
  {
    id: "python",
    name: "Python app",
    description: "Install Python dependencies and start the app",
    adapter: "spawn",
    framework: "python",
    installCommand: "pip install -r requirements.txt",
    buildCommand: null,
    startCommand: "python app.py",
    defaultPort: 8080,
  },
  {
    id: "static",
    name: "Static site",
    description: "Serve static files from a project directory",
    adapter: "spawn",
    framework: "static",
    installCommand: null,
    buildCommand: null,
    startCommand: "npx serve -s . -l __PORT__",
    defaultPort: 3000,
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

function cloneServiceSpec(spec: RegisteredServiceSpec): RegisteredServiceSpec {
  return {
    ...spec,
    envVarKeys: [...spec.envVarKeys],
    deps: [...spec.deps],
    processPatterns: [...spec.processPatterns],
    healthCheck: { ...spec.healthCheck },
  };
}

function buildNodeOptions(): string {
  const existing = process.env.NODE_OPTIONS || "";
  const guardRequire = `--require=${ECONNRESET_GUARD_PATH}`;
  if (existing.includes(guardRequire)) return existing;
  return `${existing} ${guardRequire}`.trim();
}

function resolveSourcePath(sourcePath?: string | null): string {
  if (!sourcePath) return PERSISTED_SOURCE_ROOT;
  if (sourcePath.startsWith("/")) return sourcePath;
  return resolve(PERSISTED_SOURCE_ROOT, sourcePath);
}

function sortServices(specs: RegisteredServiceSpec[]): RegisteredServiceSpec[] {
  const byId = new Map(specs.map((service) => [service.id, service]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: RegisteredServiceSpec[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new Error(`Cycle detected in service dependencies at ${id}`);
    const spec = byId.get(id);
    if (!spec) throw new Error(`Service dependency not found: ${id}`);
    visiting.add(id);
    for (const dep of spec.deps) visit(dep);
    visiting.delete(id);
    visited.add(id);
    ordered.push(spec);
  }

  for (const spec of specs) visit(spec.id);
  return ordered;
}

function splitCommand(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function normalizeCommandParts(parts: string[]): string[] {
  if (parts[0] === "bun") {
    return [process.execPath, ...parts.slice(1)];
  }
  return parts;
}

async function runShell(
  cmd: string,
  cwd: string,
  env?: Record<string, string>,
  timeoutMs: number = 60_000,
): Promise<{ ok: boolean; output: string }> {
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...env,
    CI: "1",
    FORCE_COLOR: "0",
  };

  if (!cmd.trim()) return { ok: false, output: "Empty command" };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["/bin/sh", "-c", cmd], {
      cwd,
      env: mergedEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { ok: false, output: String(err) };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array> | null).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array> | null).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const output = `${stdoutBuf}\n${stderrBuf}`.trim();
    if (timedOut)
      return {
        ok: false,
        output: `${output}\n[TIMEOUT after ${timeoutMs}ms]`.trim(),
      };
    return { ok: exitCode === 0, output };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, output: String(err) };
  }
}

async function testPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const server = Bun.serve({
        port,
        fetch() {
          return new Response("");
        },
      });
      server.stop(true);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

async function findAvailablePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
    if (await testPortAvailable(port)) return port;
  }
  throw new Error("Could not find an available port after 50 attempts");
}

async function probeTcpPort(
  port: number,
  timeoutMs: number = 2000,
): Promise<boolean> {
  try {
    const net = require("net");
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

async function probeHttpPort(
  port: number,
  path: string = "/",
  timeoutMs: number = 2000,
): Promise<boolean> {
  try {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const res = await fetch(`http://127.0.0.1:${port}${normalizedPath}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function probeServicePort(
  spec: RegisteredServiceSpec,
  timeoutMs: number = 2000,
): Promise<boolean> {
  if (!spec.port) return false;
  if (spec.healthCheck.type === "none") return false;
  if (spec.healthCheck.type === "http") {
    return probeHttpPort(spec.port, spec.healthCheck.path, timeoutMs);
  }
  return probeTcpPort(spec.port, timeoutMs);
}

async function waitForPort(
  port: number,
  timeoutMs: number = START_WAIT_MS,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeTcpPort(port, 1500)) return true;
    await Bun.sleep(500);
  }
  return false;
}

async function waitForPortToClose(
  port: number,
  timeoutMs: number = 10_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await probeTcpPort(port, 1000))) return true;
    await Bun.sleep(300);
  }
  return false;
}

async function killPidAndWait(
  pid: number,
  port?: number | null,
  timeoutMs: number = 5_000,
): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  await Bun.sleep(500);

  if (port) {
    const closed = await waitForPortToClose(port, timeoutMs).catch(() => false);
    if (closed) return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  if (port) await waitForPortToClose(port, timeoutMs).catch(() => {});
}

async function findPidByPattern(pattern: string): Promise<number | null> {
  const result = await runShell(
    `pgrep -af ${JSON.stringify(pattern)}`,
    WORKSPACE_ROOT,
    undefined,
    5000,
  );
  if (!result.ok || !result.output) return null;

  for (const line of result.output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;

    const value = parseInt(match[1], 10);
    const cmdline = match[2] || "";

    if (!Number.isFinite(value) || value <= 0) continue;
    if (value === process.pid) continue;
    if (cmdline.includes("pgrep -f") || cmdline.includes("pgrep -af")) continue;

    return value;
  }

  return null;
}

async function findPidByPort(port: number): Promise<number | null> {
  const commands = [`fuser ${port}/tcp`, `fuser -4 ${port}/tcp`];

  for (const command of commands) {
    const result = await runShell(command, WORKSPACE_ROOT, undefined, 5000);
    if (!result.ok || !result.output) continue;

    const matches = result.output.match(/\b\d+\b/g) || [];
    for (const token of matches) {
      const value = parseInt(token, 10);
      if (Number.isFinite(value) && value > 0 && value !== process.pid) {
        return value;
      }
    }
  }

  return null;
}

function getInnerNsPid(procPid: number): number | null {
  try {
    const status = readFileSync(`/proc/${procPid}/status`, "utf-8");
    const nspidLine = status
      .split("\n")
      .find((line) => line.startsWith("NSpid:"));
    if (!nspidLine) return null;
    const nspids = nspidLine.split(/\s+/).slice(1).map(Number);
    const innerPid = nspids[nspids.length - 1];
    return !Number.isNaN(innerPid) && innerPid > 0 ? innerPid : null;
  } catch {
    return null;
  }
}

export function detectFramework(sourcePath: string): string {
  const pkgPath = join(sourcePath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps: Record<string, string> = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      if (allDeps.next) return "nextjs";
      if (
        allDeps.vite ||
        Object.keys(allDeps).some((k) => k.startsWith("@vitejs"))
      )
        return "vite";
      if (allDeps["react-scripts"]) return "cra";
      if (allDeps.express || allDeps.hono || allDeps.fastify || allDeps.koa)
        return "node";
      if (pkg.scripts?.start) return "node";
    } catch {
      // ignore invalid json
    }
  }

  if (
    existsSync(join(sourcePath, "requirements.txt")) ||
    existsSync(join(sourcePath, "pyproject.toml"))
  ) {
    return "python";
  }

  if (existsSync(join(sourcePath, "index.html"))) {
    return "static";
  }

  return "unknown";
}

export function getFrameworkCommands(
  framework: string,
  sourcePath: string,
  entrypoint?: string,
): FrameworkCommands {
  switch (framework) {
    case "nextjs":
      return {
        install: "npm install",
        build: "npm run build",
        start: entrypoint || "npm start",
      };
    case "vite":
      return {
        install: "npm install",
        build: "npm run build",
        start: entrypoint || "npx vite preview --host 0.0.0.0 --port __PORT__",
      };
    case "cra":
      return {
        install: "npm install",
        build: "npm run build",
        start: entrypoint || "npx serve -s build -l __PORT__",
      };
    case "node":
      return {
        install: "npm install",
        build: null,
        start: entrypoint || "npm start",
      };
    case "python": {
      const hasRequirements = existsSync(join(sourcePath, "requirements.txt"));
      return {
        install: hasRequirements ? "pip install -r requirements.txt" : null,
        build: null,
        start: entrypoint || "python app.py",
      };
    }
    case "static":
      return {
        install: null,
        build: null,
        start: entrypoint || "npx serve -s . -l __PORT__",
      };
    default:
      return {
        install: null,
        build: null,
        start: entrypoint || "npm start",
      };
  }
}

function shouldRunInstall(installCommand: string, sourcePath: string): boolean {
  if (
    installCommand.includes("npm ") ||
    installCommand.includes("bun ") ||
    installCommand.includes("yarn") ||
    installCommand.includes("pnpm")
  ) {
    return existsSync(join(sourcePath, "package.json"));
  }
  if (installCommand.includes("pip ")) {
    return existsSync(join(sourcePath, "requirements.txt"));
  }
  return true;
}

export class ServiceManager {
  private services = new Map<string, ManagedService>();
  private started = false;
  private readonly registryFile: string;
  private readonly logsDir: string;
  private readonly builtins: RegisteredServiceSpec[];
  private watchdogTimer: Timer | null = null;
  private recoveryInFlight = new Map<string, Promise<ServiceActionResult>>();
  private lastRecoveryAt = new Map<string, number>();

  constructor(options?: {
    registryFile?: string;
    logsDir?: string;
    builtins?: RegisteredServiceSpec[];
  }) {
    this.registryFile = options?.registryFile || REGISTRY_FILE;
    this.logsDir = options?.logsDir || LOG_DIR;
    const source = options?.builtins || BUILTIN_SERVICES;
    const isolation = process.env.KORTIX_LINUX_ISOLATION === 'on';
    this.builtins = source
      .filter((spec) => !(isolation && spec.id === 'opencode-serve'))
      .map(cloneServiceSpec);
  }

  private ensureStorage(): void {
    mkdirSync(dirname(this.registryFile), { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
  }

  private logFilePath(id: string): string {
    return join(this.logsDir, `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`);
  }

  private pidFilePath(id: string): string {
    return join(this.logsDir, `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.pid`);
  }

  private appendLog(id: string, line: string): void {
    this.ensureStorage();
    appendFileSync(
      this.logFilePath(id),
      `${line.endsWith("\n") ? line : `${line}\n`}`,
    );
  }

  private writePidFile(id: string, pid: number | null): void {
    this.ensureStorage();
    const pidPath = this.pidFilePath(id);
    if (!pid) {
      try {
        rmSync(pidPath, { force: true });
      } catch {}
      return;
    }
    writeFileSync(pidPath, String(pid));
  }

  private readPidFile(id: string): number | null {
    try {
      const value = parseInt(
        readFileSync(this.pidFilePath(id), "utf-8").trim(),
        10,
      );
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private emptyState(spec: RegisteredServiceSpec): ServiceStateSnapshot {
    return {
      id: spec.id,
      name: spec.name,
      adapter: spec.adapter,
      scope: spec.scope,
      status: "stopped",
      desiredState: spec.desiredState,
      builtin: spec.builtin,
      userVisible: spec.userVisible,
      pid: null,
      port: spec.port ?? null,
      framework: spec.framework ?? null,
      sourcePath: spec.sourcePath ?? null,
      projectId: spec.projectId ?? null,
      template: spec.template ?? null,
      autoStart: spec.autoStart,
      restarts: 0,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      managed: true,
    };
  }

  private hydrateManagedService(spec: RegisteredServiceSpec): ManagedService {
    return {
      spec,
      proc: null,
      state: this.emptyState(spec),
      intentionallyStopped: false,
      startupPromise: null,
    };
  }

  private mergeBuiltins(
    persisted: RegisteredServiceSpec[],
  ): RegisteredServiceSpec[] {
    const persistedMap = new Map(persisted.map((s) => [s.id, s]));
    const merged: RegisteredServiceSpec[] = [];
    for (const builtin of this.builtins) {
      const p = persistedMap.get(builtin.id);
      const now = nowIso();
      const next = cloneServiceSpec(builtin);
      next.createdAt = p?.createdAt || now;
      next.updatedAt = now;
      if (p) {
        next.desiredState = p.desiredState || next.desiredState;
        next.autoStart = p.autoStart ?? next.autoStart;
        next.port = p.port ?? next.port;
      }
      merged.push(next);
      persistedMap.delete(builtin.id);
    }
    for (const spec of persistedMap.values()) {
      merged.push({
        ...cloneServiceSpec(spec),
        createdAt: spec.createdAt || nowIso(),
        updatedAt: spec.updatedAt || nowIso(),
      });
    }
    sortServices(merged);
    return merged;
  }

  private loadRegistryFromDisk(): RegisteredServiceSpec[] {
    this.ensureStorage();
    let persisted: RegisteredServiceSpec[] = [];
    if (existsSync(this.registryFile)) {
      try {
        const raw = JSON.parse(
          readFileSync(this.registryFile, "utf-8"),
        ) as ServiceRegistryFile;
        if (raw.version === REGISTRY_VERSION && Array.isArray(raw.services))
          persisted = raw.services;
      } catch {
        /* rebuild */
      }
    }
    return this.mergeBuiltins(persisted);
  }

  private persistRegistry(): void {
    this.ensureStorage();
    const payload: ServiceRegistryFile = {
      version: REGISTRY_VERSION,
      services: [...this.services.values()].map(({ spec }) =>
        cloneServiceSpec(spec),
      ),
    };
    const tempPath = `${this.registryFile}.tmp-${process.pid}`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    renameSync(tempPath, this.registryFile);
  }

  private async probeS6Service(item: ManagedService): Promise<void> {
    const { spec, state } = item;

    // s6-svstat requires root access to supervise dirs.
    // Instead, probe by port (if service has one) or by process pattern.
    if (spec.port && spec.healthCheck.type !== "none") {
      const portOk = await probeServicePort(
        spec,
        spec.healthCheck.timeoutMs || 1500,
      );
      if (portOk) {
        const pid = await findPidByPort(spec.port);
        state.pid = pid ? getInnerNsPid(pid) || pid : null;
        state.status = "running";
        return;
      }
    }

    // No port or port not bound — check by process pattern
    if (spec.processPatterns.length > 0) {
      const pid = await findPidByPattern(spec.processPatterns[0]);
      if (pid) {
        state.pid = getInnerNsPid(pid) || pid;
        state.status = spec.port ? "starting" : "running";
        return;
      }
    }

    state.pid = null;
    state.status = state.status === "failed" ? "failed" : "stopped";
  }

  private async probeManagedService(item: ManagedService): Promise<void> {
    const { spec, state } = item;

    if (spec.adapter === "s6") {
      return this.probeS6Service(item);
    }

    // Spawn adapter
    if (!item.proc) {
      const persistedPid = this.readPidFile(spec.id);
      const adoptedPid =
        (spec.port ? await findPidByPort(spec.port) : null) ||
        (spec.processPatterns.length > 0
          ? await findPidByPattern(spec.processPatterns[0])
          : null);
      const effectivePid = persistedPid || adoptedPid;
      if (effectivePid) {
        const portOk = spec.port
          ? await probeServicePort(spec, spec.healthCheck.timeoutMs || 1500)
          : true;
        state.pid = getInnerNsPid(effectivePid) || effectivePid;
        state.status = portOk ? "running" : "starting";
        return;
      }
      state.pid = null;
      state.status = state.status === "failed" ? "failed" : "stopped";
      return;
    }
    if (spec.port) {
      const healthy = await probeServicePort(
        spec,
        spec.healthCheck.timeoutMs || 1500,
      );
      state.status = healthy
        ? "running"
        : state.status === "starting"
          ? "starting"
          : "running";
    }
  }

  private async isServiceHealthy(item: ManagedService): Promise<boolean> {
    const { spec, state } = item;

    if (spec.adapter === "s6" && spec.healthCheck.type === "none") {
      return state.status === "running";
    }

    if (spec.port) {
      return probeServicePort(spec, spec.healthCheck.timeoutMs || 1500);
    }

    if (spec.adapter === "s6") {
      return state.status === "running";
    }

    return !!item.proc || !!state.pid;
  }

  private shouldAutoHeal(item: ManagedService): boolean {
    const { spec } = item;
    if (spec.desiredState !== "running") return false;
    if (!spec.autoStart && !spec.builtin) return false;
    return true;
  }

  private isWithinStartupGrace(item: ManagedService): boolean {
    if (!item.proc) return false;
    if (item.state.status !== "starting") return false;
    if (!item.state.startedAt) return false;

    const startedAt = Date.parse(item.state.startedAt);
    if (Number.isNaN(startedAt)) return false;
    return Date.now() - startedAt < START_WAIT_MS;
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog("interval");
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async runWatchdog(trigger: "interval" | "manual"): Promise<void> {
    await this.ensureInitialized();
    for (const item of this.services.values()) {
      if (!this.shouldAutoHeal(item)) continue;
      await this.probeManagedService(item);
      if (this.isWithinStartupGrace(item)) continue;
      const healthy = await this.isServiceHealthy(item);
      if (healthy) continue;
      void this.requestRecovery(item.spec.id, `watchdog:${trigger}`);
    }
  }

  async requestRecovery(
    id: string,
    reason: string,
  ): Promise<ServiceActionResult | null> {
    await this.ensureInitialized();
    const item = this.services.get(id);
    if (!item || !this.shouldAutoHeal(item)) return null;

    const inFlight = this.recoveryInFlight.get(id);
    if (inFlight) return inFlight;

    if (item.startupPromise) {
      this.appendLog(
        id,
        `[manager] recovery joined active startup (${reason})`,
      );
      return item.startupPromise;
    }

    const lastRecoveryAt = this.lastRecoveryAt.get(id) || 0;
    if (Date.now() - lastRecoveryAt < RECOVERY_THROTTLE_MS) {
      return {
        ok: false,
        output: `Recovery throttled for ${id}`,
        service: this.buildServiceSnapshot(item),
      };
    }

    const recovery = (async () => {
      this.lastRecoveryAt.set(id, Date.now());
      await this.probeManagedService(item);
      if (item.startupPromise) {
        this.appendLog(
          id,
          `[manager] recovery waiting for startup (${reason})`,
        );
        return item.startupPromise;
      }
      if (await this.isServiceHealthy(item)) {
        return {
          ok: true,
          output: "already healthy",
          service: this.buildServiceSnapshot(item),
        };
      }

      this.appendLog(id, `[manager] auto-heal triggered (${reason})`);

      if (item.spec.adapter === "s6") {
        if (item.state.status === "running") {
          return this.restartS6Service(item);
        } else {
          return this.startS6Service(item);
        }
      }

      if (item.proc) {
        await this.stopSpawnService(item);
      }

      const result = await this.startSpawnService(item);
      if (!result.ok) {
        this.appendLog(
          id,
          `[manager] auto-heal failed (${reason}): ${result.output}`,
        );
      }
      return result;
    })();

    this.recoveryInFlight.set(id, recovery);
    void recovery.finally(() => {
      if (this.recoveryInFlight.get(id) === recovery) {
        this.recoveryInFlight.delete(id);
      }
    });
    return recovery;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.started) return;
    const isolation = process.env.KORTIX_LINUX_ISOLATION === 'on';
    const specs = this.loadRegistryFromDisk().filter(
      (spec) => !(isolation && spec.id === 'opencode-serve'),
    );
    this.services.clear();
    for (const spec of specs) {
      this.services.set(spec.id, this.hydrateManagedService(spec));
    }
    this.persistRegistry();
    this.started = true;
  }

  private buildServiceEnv(spec: RegisteredServiceSpec): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of spec.envVarKeys) {
      if (process.env[key]) env[key] = process.env[key] as string;
    }
    if (spec.port) env.PORT = String(spec.port);
    env.HOST = "0.0.0.0";
    env.NODE_OPTIONS = buildNodeOptions();
    return env;
  }

  private async captureProcessOutput(
    id: string,
    proc: ReturnType<typeof Bun.spawn>,
  ): Promise<void> {
    const readStream = async (
      stream: ReadableStream<Uint8Array> | null,
      prefix: string,
    ) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (line.trim()) this.appendLog(id, `[${prefix}] ${line}`);
          }
        }
      } catch {
        // ignore closed stream
      }
    };

    void readStream(proc.stdout as ReadableStream<Uint8Array> | null, "stdout");
    void readStream(proc.stderr as ReadableStream<Uint8Array> | null, "stderr");
  }

  private async startSpawnService(
    item: ManagedService,
  ): Promise<ServiceActionResult> {
    const { spec, state } = item;
    if (!spec.startCommand)
      return { ok: false, output: `Missing start command for ${spec.id}` };
    if (item.startupPromise) {
      return item.startupPromise;
    }
    if (item.proc && state.status !== "stopped" && state.status !== "failed") {
      return { ok: true, output: "already running", service: { ...state } };
    }

    if (
      spec.port &&
      (await probeServicePort(spec, spec.healthCheck.timeoutMs || 1500))
    ) {
      const persistedPid = this.readPidFile(spec.id);
      const adoptedPid =
        (spec.processPatterns.length > 0
          ? await findPidByPattern(spec.processPatterns[0])
          : null) || (await findPidByPort(spec.port));
      if (item.proc) {
        state.status = "running";
        state.port = spec.port;
        state.pid = item.proc.pid;
        state.startedAt = state.startedAt || nowIso();
        return { ok: true, output: "already running", service: { ...state } };
      }

      const existingPid =
        persistedPid ||
        (adoptedPid ? getInnerNsPid(adoptedPid) || adoptedPid : null);
      if (existingPid) {
        if (existingPid === process.pid) {
          this.appendLog(
            spec.id,
            `[manager] refusing to reclaim port ${spec.port} from current process pid ${existingPid}`,
          );
        } else {
          this.appendLog(
            spec.id,
            `[manager] reclaiming port ${spec.port} from pid ${existingPid}`,
          );
          await killPidAndWait(existingPid, spec.port, 5_000);
        }
      }
    }

    const cwd = resolveSourcePath(spec.sourcePath);
    if (!existsSync(cwd)) {
      state.status = "failed";
      state.lastError = `Source path not found: ${cwd}`;
      state.stoppedAt = nowIso();
      return { ok: false, output: state.lastError, service: { ...state } };
    }

    state.status = "starting";
    state.lastError = null;
    state.stoppedAt = null;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["/bin/sh", "-c", spec.startCommand], {
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          ...this.buildServiceEnv(spec),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      state.status = "failed";
      state.lastError = String(err);
      state.stoppedAt = nowIso();
      return { ok: false, output: state.lastError, service: { ...state } };
    }

    item.proc = proc;
    item.intentionallyStopped = false;
    state.pid = proc.pid;
    this.writePidFile(spec.id, proc.pid);
    state.startedAt = nowIso();
    state.port = spec.port ?? null;
    this.appendLog(spec.id, `[manager] starting ${spec.startCommand}`);
    void this.captureProcessOutput(spec.id, proc);

    void proc.exited.then(async (exitCode) => {
      if (item.proc !== proc) return;
      item.proc = null;
      item.startupPromise = null;
      state.pid = null;
      this.writePidFile(spec.id, null);
      state.stoppedAt = nowIso();
      if (item.intentionallyStopped || item.spec.desiredState === "stopped") {
        state.status = "stopped";
        return;
      }
      state.status = "failed";
      state.lastError = `Exited with code ${exitCode}`;
      this.appendLog(spec.id, `[manager] exited with code ${exitCode}`);
      if (item.spec.restartPolicy === "never") return;
      if (item.spec.restartPolicy === "on-failure" && exitCode === 0) return;
      state.restarts += 1;
      state.status = "backoff";
      const delay = item.spec.restartDelayMs || 1500;
      this.appendLog(spec.id, `[manager] restarting in ${delay}ms`);
      setTimeout(() => {
        if (item.spec.desiredState !== "running") return;
        void this.startSpawnService(item);
      }, delay);
    });

    const startupPromise = (async (): Promise<ServiceActionResult> => {
      if (spec.port) {
        const ready = await waitForPort(spec.port, START_WAIT_MS);
        if (!ready) {
          state.status = "failed";
          state.lastError = `Service did not bind port ${spec.port} within ${START_WAIT_MS / 1000}s`;
          try {
            proc.kill();
          } catch {}
          return { ok: false, output: state.lastError, service: { ...state } };
        }
      }

      state.status = "running";
      return { ok: true, output: "running", service: { ...state } };
    })();

    item.startupPromise = startupPromise;
    void startupPromise.finally(() => {
      if (item.startupPromise === startupPromise) {
        item.startupPromise = null;
      }
    });

    return startupPromise;
  }

  private async stopSpawnService(
    item: ManagedService,
  ): Promise<ServiceActionResult> {
    const { spec, state } = item;
    item.startupPromise = null;
    if (!item.proc) {
      const persistedPid = this.readPidFile(spec.id);
      const adoptedPid =
        persistedPid ||
        (spec.processPatterns.length > 0
          ? await findPidByPattern(spec.processPatterns[0])
          : null) ||
        (spec.port ? await findPidByPort(spec.port) : null);
      if (adoptedPid) {
        const innerPid = getInnerNsPid(adoptedPid) || adoptedPid;
        if (innerPid !== process.pid) {
          try {
            process.kill(innerPid, "SIGTERM");
          } catch {}
          await Bun.sleep(500);
          if (spec.port) {
            const closed = await waitForPortToClose(spec.port, 3000).catch(
              () => false,
            );
            if (!closed) {
              try {
                process.kill(innerPid, "SIGKILL");
              } catch {}
              await waitForPortToClose(spec.port, 3000).catch(() => {});
            }
          }
        }
      }
      state.status = "stopped";
      state.pid = null;
      this.writePidFile(spec.id, null);
      state.stoppedAt = nowIso();
      return { ok: true, output: "already stopped", service: { ...state } };
    }

    item.intentionallyStopped = true;
    const proc = item.proc;
    try {
      proc.kill("SIGTERM");
    } catch {}

    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);

    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }

    item.proc = null;
    state.status = "stopped";
    state.pid = null;
    this.writePidFile(spec.id, null);
    state.stoppedAt = nowIso();
    if (spec.port) await waitForPortToClose(spec.port, 5000).catch(() => {});
    return {
      ok: true,
      output: exited ? "stopped" : "killed",
      service: { ...state },
    };
  }

  // ── s6 adapter: system services supervised by s6, controlled via s6-svc ──

  private async startS6Service(
    item: ManagedService,
  ): Promise<ServiceActionResult> {
    const spec = item.spec;
    if (!spec.s6ServiceName)
      return { ok: false, output: `No s6ServiceName for ${spec.id}` };
    // s6-svc -u brings up a supervised longrun. Idempotent if already up.
    try {
      Bun.spawnSync([
        "/usr/bin/s6-svc",
        "-u",
        `/run/service/${spec.s6ServiceName}`,
      ]);
    } catch {}
    await Bun.sleep(1000);
    await this.probeS6Service(item);
    return {
      ok: true,
      output: item.state.status === "running" ? "running" : "starting",
      service: { ...item.state },
    };
  }

  private async stopS6Service(
    item: ManagedService,
  ): Promise<ServiceActionResult> {
    const spec = item.spec;
    if (!spec.s6ServiceName)
      return { ok: false, output: `No s6ServiceName for ${spec.id}` };
    try {
      Bun.spawnSync([
        "/usr/bin/s6-svc",
        "-d",
        `/run/service/${spec.s6ServiceName}`,
      ]);
    } catch {}
    if (spec.port) await waitForPortToClose(spec.port, 5000).catch(() => {});
    item.state.status = "stopped";
    item.state.pid = null;
    item.state.stoppedAt = nowIso();
    return { ok: true, output: "stopped", service: { ...item.state } };
  }

  private async restartS6Service(
    item: ManagedService,
  ): Promise<ServiceActionResult> {
    const spec = item.spec;
    if (!spec.s6ServiceName)
      return { ok: false, output: `No s6ServiceName for ${spec.id}` };
    try {
      Bun.spawnSync([
        "/usr/bin/s6-svc",
        "-r",
        `/run/service/${spec.s6ServiceName}`,
      ]);
    } catch {}
    if (spec.port) {
      await waitForPortToClose(spec.port, 3000).catch(() => {});
      await waitForPort(spec.port, START_WAIT_MS).catch(() => {});
    } else {
      await Bun.sleep(1000);
    }
    await this.probeS6Service(item);
    return { ok: true, output: "restarted", service: { ...item.state } };
  }

  private async cleanupLegacyOrphans(): Promise<void> {
    const patterns = [
      "/usr/local/bin/opencode serve --port 4096 --hostname 0.0.0.0",
      "/usr/bin/opencode serve --port 4096 --hostname 0.0.0.0",
      "bash /ephemeral/kortix-master/scripts/run-opencode-serve.sh",
      "/tmp/static-web-server.js",
    ];
    for (const pattern of patterns) {
      await runShell(
        `pkill -f ${JSON.stringify(pattern)}`,
        WORKSPACE_ROOT,
        undefined,
        10_000,
      ).catch(() => {});
    }
  }

  async start(): Promise<void> {
    await this.ensureInitialized();
    await this.cleanupLegacyOrphans();
    await this.reconcile();
    this.startWatchdog();
  }

  async stop(): Promise<void> {
    await this.ensureInitialized();
    this.stopWatchdog();
    const ids = [...this.services.keys()].reverse();
    for (const id of ids) {
      const item = this.services.get(id);
      if (!item) continue;
      if (item.spec.adapter === "spawn") {
        await this.stopSpawnService(item);
      }
    }
  }

  async syncStatuses(): Promise<void> {
    await this.ensureInitialized();
    for (const item of this.services.values()) {
      await this.probeManagedService(item);
    }
  }

  private buildServiceSnapshot(item: ManagedService): ServiceStateSnapshot {
    return {
      ...item.state,
      desiredState: item.spec.desiredState,
      builtin: item.spec.builtin,
      userVisible: item.spec.userVisible,
      port: item.spec.port ?? null,
      framework: item.spec.framework ?? null,
      sourcePath: item.spec.sourcePath ?? null,
      projectId: item.spec.projectId ?? null,
      template: item.spec.template ?? null,
      autoStart: item.spec.autoStart,
    };
  }

  async listServices(options?: {
    includeSystem?: boolean;
    includeStopped?: boolean;
  }): Promise<ServiceStateSnapshot[]> {
    await this.ensureInitialized();
    await this.syncStatuses();
    const includeSystem = options?.includeSystem ?? false;
    const includeStopped = options?.includeStopped ?? false;
    return [...this.services.values()]
      .map((item) => this.buildServiceSnapshot(item))
      .filter((service) => includeSystem || service.userVisible)
      .filter(
        (service) =>
          includeStopped ||
          service.status === "running" ||
          service.status === "starting" ||
          service.status === "backoff",
      );
  }

  async getService(id: string): Promise<ServiceStateSnapshot | null> {
    await this.ensureInitialized();
    const item = this.services.get(id);
    if (!item) return null;
    await this.probeManagedService(item);
    return this.buildServiceSnapshot(item);
  }

  async getCoreStatus(): Promise<{
    running: boolean;
    services: ServiceStateSnapshot[];
  }> {
    await this.ensureInitialized();
    await this.syncStatuses();
    const services = [...this.services.values()]
      .filter(
        (item) => item.spec.scope === "core" || item.spec.scope === "bootstrap",
      )
      .map((item) => this.buildServiceSnapshot(item));
    return {
      running: this.started,
      services,
    };
  }

  async registerService(
    input: RegisterServiceInput,
  ): Promise<ServiceStateSnapshot> {
    await this.ensureInitialized();
    const existing = this.services.get(input.id);
    const now = nowIso();

    if (existing?.spec.builtin) {
      const next = cloneServiceSpec(existing.spec);
      if (input.desiredState) next.desiredState = input.desiredState;
      if (input.autoStart !== undefined) next.autoStart = input.autoStart;
      next.updatedAt = now;
      existing.spec = next;
      existing.state = this.buildServiceSnapshot(existing);
      this.persistRegistry();
      return this.buildServiceSnapshot(existing);
    }

    const adapter: ServiceAdapter = "spawn";
    const next: RegisteredServiceSpec = {
      id: input.id,
      name: input.name || existing?.spec.name || input.id,
      adapter,
      scope: input.scope || existing?.spec.scope || "project",
      description: input.description || existing?.spec.description || "",
      builtin: false,
      userVisible: input.userVisible ?? existing?.spec.userVisible ?? true,
      projectId: input.projectId ?? existing?.spec.projectId ?? null,
      template: input.template ?? existing?.spec.template ?? "custom-command",
      framework: input.framework ?? existing?.spec.framework ?? null,
      sourcePath: resolveSourcePath(
        input.sourcePath ?? existing?.spec.sourcePath ?? WORKSPACE_ROOT,
      ),
      sourceType: existing?.spec.sourceType || "files",
      sourceRef: existing?.spec.sourceRef || null,
      startCommand: input.startCommand ?? existing?.spec.startCommand ?? null,
      installCommand:
        input.installCommand ?? existing?.spec.installCommand ?? null,
      buildCommand: input.buildCommand ?? existing?.spec.buildCommand ?? null,
      envVarKeys: [
        ...new Set(input.envVarKeys ?? existing?.spec.envVarKeys ?? []),
      ],
      deps: [...new Set(input.deps ?? existing?.spec.deps ?? [])],
      port: input.port ?? existing?.spec.port ?? null,
      desiredState:
        input.desiredState ?? existing?.spec.desiredState ?? "running",
      autoStart: input.autoStart ?? existing?.spec.autoStart ?? true,
      restartPolicy:
        input.restartPolicy ?? existing?.spec.restartPolicy ?? "always",
      restartDelayMs:
        input.restartDelayMs ?? existing?.spec.restartDelayMs ?? 1500,
      s6ServiceName:
        input.s6ServiceName ?? existing?.spec.s6ServiceName ?? null,
      processPatterns: [
        ...new Set(
          input.processPatterns ?? existing?.spec.processPatterns ?? [],
        ),
      ],
      healthCheck: {
        type:
          input.healthCheck?.type || existing?.spec.healthCheck.type || "none",
        path: input.healthCheck?.path ?? existing?.spec.healthCheck.path,
        timeoutMs:
          input.healthCheck?.timeoutMs ??
          existing?.spec.healthCheck.timeoutMs ??
          2000,
      },
      createdAt: existing?.spec.createdAt || now,
      updatedAt: now,
    };

    if (!next.startCommand) {
      throw new Error(`Service ${next.id} requires a startCommand`);
    }

    if (existing) {
      existing.spec = next;
      existing.state = {
        ...existing.state,
        name: next.name,
        adapter: next.adapter,
        scope: next.scope,
        port: next.port ?? null,
        framework: next.framework ?? null,
        sourcePath: next.sourcePath ?? null,
        projectId: next.projectId ?? null,
        template: next.template ?? null,
        desiredState: next.desiredState,
        autoStart: next.autoStart,
        userVisible: next.userVisible,
      };
    } else {
      this.services.set(next.id, this.hydrateManagedService(next));
    }

    this.persistRegistry();
    return this.buildServiceSnapshot(this.services.get(next.id)!);
  }

  async unregisterService(id: string): Promise<ServiceActionResult> {
    await this.ensureInitialized();
    const item = this.services.get(id);
    if (!item) return { ok: false, output: `Unknown service: ${id}` };
    if (item.spec.builtin)
      return { ok: false, output: `Cannot unregister builtin service: ${id}` };
    await this.stopService(id);
    this.services.delete(id);
    this.persistRegistry();
    try {
      rmSync(this.logFilePath(id), { force: true });
    } catch {}
    return { ok: true, output: `Removed ${id}` };
  }

  async startService(id: string): Promise<ServiceActionResult> {
    await this.ensureInitialized();
    const item = this.services.get(id);
    if (!item) return { ok: false, output: `Unknown service: ${id}` };

    for (const depId of item.spec.deps) {
      const dep = this.services.get(depId);
      if (!dep) return { ok: false, output: `Dependency not found: ${depId}` };
      await this.probeManagedService(dep);
      if (dep.state.status !== "running") {
        return { ok: false, output: `Dependency not running: ${depId}` };
      }
    }

    item.spec.desiredState = "running";
    item.spec.updatedAt = nowIso();
    this.persistRegistry();

    const result =
      item.spec.adapter === "s6"
        ? await this.startS6Service(item)
        : await this.startSpawnService(item);
    return { ...result, service: this.buildServiceSnapshot(item) };
  }

  async stopService(
    id: string,
    options?: { persistDesiredState?: boolean },
  ): Promise<ServiceActionResult> {
    await this.ensureInitialized();
    const item = this.services.get(id);
    if (!item) return { ok: false, output: `Unknown service: ${id}` };

    if ((options?.persistDesiredState ?? true) === true) {
      item.spec.desiredState = "stopped";
      item.spec.updatedAt = nowIso();
      this.persistRegistry();
    }

    const result =
      item.spec.adapter === "s6"
        ? await this.stopS6Service(item)
        : await this.stopSpawnService(item);
    return { ...result, service: this.buildServiceSnapshot(item) };
  }

  async restartService(id: string): Promise<ServiceActionResult> {
    await this.ensureInitialized();
    const item = this.services.get(id);
    if (!item) return { ok: false, output: `Unknown service: ${id}` };

    if (item.spec.adapter === "s6") return this.restartS6Service(item);
    await this.stopSpawnService(item);
    return this.startService(id);
  }

  async reconcile(): Promise<ServiceActionResult> {
    await this.ensureInitialized();
    const ordered = sortServices(
      [...this.services.values()].map(({ spec }) => spec),
    );
    for (const spec of ordered) {
      const item = this.services.get(spec.id)!;
      if (!spec.autoStart && spec.desiredState !== "running") {
        await this.probeManagedService(item);
        continue;
      }
      if (spec.desiredState === "running") {
        // s6 services are auto-started by s6 — just probe status
        if (spec.adapter === "s6") {
          await this.probeManagedService(item);
          continue;
        }
        if (item.proc) {
          await this.probeManagedService(item);
          continue;
        }
        await this.startSpawnService(item);
      } else {
        if (spec.adapter === "spawn" && item.proc) {
          await this.stopSpawnService(item);
        }
      }
    }
    this.persistRegistry();
    return { ok: true, output: `Reconciled ${this.services.size} services` };
  }

  async reloadFromDiskAndReconcile(): Promise<ServiceActionResult> {
    const currentProcesses = [...this.services.values()].filter(
      (item) => item.proc,
    );
    for (const item of currentProcesses) {
      await this.stopSpawnService(item);
    }
    this.started = false;
    await this.ensureInitialized();
    return this.reconcile();
  }

  async prepareForFullReload(): Promise<{ stopped: string[] }> {
    await this.ensureInitialized();
    const ordered = sortServices(
      [...this.services.values()].map(({ spec }) => spec),
    ).reverse();
    const stopped: string[] = [];

    for (const spec of ordered) {
      const item = this.services.get(spec.id);
      if (!item) continue;
      await this.stopService(spec.id, { persistDesiredState: false });
      stopped.push(spec.id);
    }

    return { stopped };
  }

  async getLogs(
    id: string,
    limit: number = 500,
  ): Promise<{ logs: string[]; error?: string }> {
    await this.ensureInitialized();
    const item = this.services.get(id);
    if (!item) return { logs: [], error: `Service not found: ${id}` };
    const logPath = this.logFilePath(id);
    if (!existsSync(logPath)) return { logs: [] };
    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    return { logs: lines.slice(-limit) };
  }

  listTemplates(): ServiceTemplate[] {
    return SERVICE_TEMPLATES.map((template) => ({ ...template }));
  }

  async deployLegacyService(
    config: LegacyDeploymentConfig,
  ): Promise<DeployResult> {
    await this.ensureInitialized();
    const logs: string[] = [];
    const pushLog = (message: string) => {
      logs.push(message);
    };

    try {
      const sourcePath = resolveSourcePath(config.sourcePath || WORKSPACE_ROOT);
      if (!existsSync(sourcePath) && config.sourceType !== "git") {
        return {
          success: false,
          error: `Source path not found: ${sourcePath}`,
          framework: "unknown",
          logs,
        };
      }

      if (config.sourceType === "git" && config.sourceRef) {
        if (existsSync(join(sourcePath, ".git"))) {
          const pull = await runShell(
            "git pull",
            sourcePath,
            undefined,
            60_000,
          );
          pushLog(pull.output);
          if (!pull.ok) {
            return {
              success: false,
              error: "Git pull failed",
              framework: "unknown",
              logs,
            };
          }
        } else {
          mkdirSync(sourcePath, { recursive: true });
          const clone = await runShell(
            `git clone ${config.sourceRef} .`,
            sourcePath,
            undefined,
            120_000,
          );
          pushLog(clone.output);
          if (!clone.ok) {
            return {
              success: false,
              error: "Git clone failed",
              framework: "unknown",
              logs,
            };
          }
        }
      }

      const framework = config.framework || detectFramework(sourcePath);
      const cmds = getFrameworkCommands(
        framework,
        sourcePath,
        config.entrypoint,
      );

      const env: Record<string, string> = {};
      for (const key of config.envVarKeys || []) {
        if (process.env[key]) env[key] = process.env[key] as string;
      }

      let buildDuration: number | undefined;
      if (cmds.install && shouldRunInstall(cmds.install, sourcePath)) {
        const started = Date.now();
        const install = await runShell(
          cmds.install,
          sourcePath,
          env,
          INSTALL_TIMEOUT_MS,
        );
        buildDuration = Date.now() - started;
        pushLog(install.output);
        if (!install.ok) {
          return {
            success: false,
            error: `Install failed (${Math.round(buildDuration / 1000)}s)`,
            framework,
            logs,
            buildDuration,
          };
        }
      }

      if (cmds.build) {
        const started = Date.now();
        const build = await runShell(
          cmds.build,
          sourcePath,
          env,
          BUILD_TIMEOUT_MS,
        );
        buildDuration = Date.now() - started;
        pushLog(build.output);
        if (!build.ok) {
          return {
            success: false,
            error: `Build failed (${Math.round(buildDuration / 1000)}s)`,
            framework,
            logs,
            buildDuration,
          };
        }
      }

      const existing = this.services.get(config.deploymentId);
      const port = existing?.spec.port || (await findAvailablePort());

      const startCommand = cmds.start.replace(/__PORT__/g, String(port));
      const processPattern =
        (config.entrypoint || startCommand)
          .split(/\s+/)
          .filter(Boolean)
          .pop() || startCommand;

      await this.registerService({
        id: config.deploymentId,
        name: config.deploymentId,
        adapter: "spawn",
        scope: "project",
        template: framework,
        framework,
        sourcePath,
        startCommand,
        installCommand: cmds.install,
        buildCommand: cmds.build,
        envVarKeys: config.envVarKeys || [],
        processPatterns: [processPattern],
        port,
        desiredState: "running",
        autoStart: true,
        restartPolicy: "always",
        restartDelayMs: 1500,
        userVisible: true,
        healthCheck: { type: "tcp", timeoutMs: 2000 },
      });

      const startTime = Date.now();
      const started = await this.restartService(config.deploymentId);
      const startDuration = Date.now() - startTime;
      if (!started.ok || !started.service) {
        return {
          success: false,
          error: started.output,
          framework,
          logs,
          buildDuration,
          startDuration,
        };
      }

      return {
        success: true,
        service: started.service,
        port: started.service.port || undefined,
        pid: started.service.pid || undefined,
        framework,
        logs,
        buildDuration,
        startDuration,
      };
    } catch (err) {
      return {
        success: false,
        error: String(err),
        framework: config.framework || "unknown",
        logs,
      };
    }
  }
}

export const serviceManager = new ServiceManager();
