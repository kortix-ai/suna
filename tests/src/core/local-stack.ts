import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_FLOW_INTERNAL_SERVICE_KEY,
  localWebUrl,
  type LocalSupabaseEnvironment,
  type LocalWorktreeConfig,
} from "./local-profile";

interface WorktreeMarker extends LocalWorktreeConfig {
  path: string;
  branch: string;
  dbMode?: "shared" | "isolated";
}

interface RegistrySlot {
  path: string;
}

export interface LocalTopology {
  root: string;
  marker: WorktreeMarker | null;
  worktreeName: string | null;
  apiUrl: string;
}

export interface LocalStackHandle {
  started: boolean;
  stop(): Promise<void>;
}

export const LOCAL_TEST_PROFILE_HEADER = "x-kortix-local-test-profile";

export interface LocalSupabaseHandle extends LocalStackHandle {
  environment: LocalSupabaseEnvironment;
}

export interface LocalMigrationPlan {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

function localPort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`invalid local ${label} port: ${String(value)}`);
  }
  return value;
}

export function assertLoopbackHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid ${label} URL: ${value}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`${label} URL must use unauthenticated loopback HTTP`);
  }
  return url;
}

function localEndpoint(baseUrl: string, label: string, suffix: string): URL {
  const url = assertLoopbackHttpUrl(baseUrl, label);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function localTopology(
  root: string,
  marker: WorktreeMarker | null,
  slots: Record<string, RegistrySlot> = {},
): LocalTopology {
  const worktreeName =
    Object.entries(slots).find(([, entry]) => entry.path === root)?.[0] ?? null;
  const apiPort = localPort(marker?.ports.api ?? 8008, "API");
  if (marker) {
    localPort(marker.ports.web, "web");
    localPort(marker.ports.gateway, "gateway");
  }
  return {
    root,
    marker,
    worktreeName,
    apiUrl: `http://127.0.0.1:${apiPort}/v1`,
  };
}

export function resolveLocalTopology(root: string): LocalTopology {
  const markerPath = join(root, ".kortix-worktree.json");
  const marker = existsSync(markerPath)
    ? (JSON.parse(readFileSync(markerPath, "utf8")) as WorktreeMarker)
    : null;
  const registryPath = join(
    process.env.KORTIX_HOME || join(homedir(), ".kortix"),
    "worktrees",
    "registry.json",
  );
  const slots = existsSync(registryPath)
    ? ((
        JSON.parse(readFileSync(registryPath, "utf8")) as {
          slots?: Record<string, RegistrySlot>;
        }
      ).slots ?? {})
    : {};
  return localTopology(root, marker, slots);
}

export function parseSupabaseEnvironment(
  output: string,
): LocalSupabaseEnvironment {
  const parsed: LocalSupabaseEnvironment = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
    if (!match) continue;
    const key = match[1] as keyof LocalSupabaseEnvironment;
    if (
      ![
        "API_URL",
        "DB_URL",
        "MAILPIT_URL",
        "ANON_KEY",
        "SERVICE_ROLE_KEY",
        "JWT_SECRET",
      ].includes(key)
    )
      continue;
    parsed[key] = match[2] ?? match[3] ?? "";
  }
  return parsed;
}

export function hasRequiredLocalSupabaseEnvironment(
  environment: LocalSupabaseEnvironment,
): boolean {
  return Boolean(
    environment.API_URL &&
      environment.DB_URL &&
      environment.ANON_KEY &&
      environment.SERVICE_ROLE_KEY,
  );
}

export async function readLocalSupabaseEnvironment(
  topology: LocalTopology,
): Promise<LocalSupabaseEnvironment> {
  const args = localSupabaseCommand(topology);
  args.push("status", "-o", "env");
  const processResult = Bun.spawn(args, {
    cwd: topology.root,
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(processResult.stdout).text();
  const exitCode = await processResult.exited;
  const environment = parseSupabaseEnvironment(stdout);
  // The CLI can return a non-zero status when optional services are stopped.
  // The local runner needs Auth, Postgres, and their credentials only.
  if (exitCode !== 0 && !hasRequiredLocalSupabaseEnvironment(environment)) {
    throw new Error("local Supabase is not running");
  }
  return environment;
}

function localSupabaseCommand(topology: LocalTopology): string[] {
  const args = ["supabase"];
  if (topology.marker?.dbMode === "isolated") {
    if (!topology.worktreeName) {
      throw new Error(
        "isolated worktree is missing from the worktree registry",
      );
    }
    args.push(
      "--workdir",
      join(
        process.env.KORTIX_HOME || join(homedir(), ".kortix"),
        "worktrees",
        topology.worktreeName,
        "sb",
      ),
    );
  }
  return args;
}

export async function ensureLocalSupabase(
  topology: LocalTopology,
  options: { autoStart: boolean },
): Promise<LocalSupabaseHandle> {
  try {
    return {
      started: false,
      environment: await readLocalSupabaseEnvironment(topology),
      stop: async () => {},
    };
  } catch (error) {
    if (!options.autoStart) throw error;
  }

  const command = [
    ...localSupabaseCommand(topology),
    "start",
    "--ignore-health-check",
  ];
  const started = Bun.spawn(command, {
    cwd: topology.root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await started.exited;
  if (exitCode !== 0) {
    throw new Error(`local Supabase start exited with code ${exitCode}`);
  }
  const environment = await readLocalSupabaseEnvironment(topology);
  return {
    started: true,
    environment,
    stop: async () => {
      const stopped = Bun.spawn([...localSupabaseCommand(topology), "stop"], {
        cwd: topology.root,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      await stopped.exited;
    },
  };
}

export function localMigrationPlan(
  topology: LocalTopology,
  supabase: LocalSupabaseEnvironment,
): LocalMigrationPlan {
  if (!supabase.DB_URL) {
    throw new Error("local Supabase environment is missing DB_URL");
  }
  return {
    command: ["pnpm", "--filter", "@kortix/db", "migrate:local"],
    cwd: topology.root,
    env: {
      ...process.env,
      DATABASE_URL: supabase.DB_URL,
    },
  };
}

export async function ensureLocalMigrations(
  topology: LocalTopology,
  supabase: LocalSupabaseEnvironment,
): Promise<void> {
  const plan = localMigrationPlan(topology, supabase);
  const migrated = Bun.spawn(plan.command, {
    cwd: plan.cwd,
    env: plan.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await migrated.exited;
  if (exitCode !== 0) {
    throw new Error(`local database migration exited with code ${exitCode}`);
  }
}

export async function localApiHealthy(apiUrl: string): Promise<boolean> {
  try {
    const response = await fetch(localEndpoint(apiUrl, "local API", "/health"), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function localApiUsesTestProfile(
  apiUrl: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const url = assertLoopbackHttpUrl(apiUrl, "local API");
    if (!/\/v1\/?$/.test(url.pathname)) return false;
    url.pathname = `${url.pathname.replace(/\/v1\/?$/, "")}/metrics`;
    url.search = "";
    url.hash = "";
    const response = await request(url, {
      headers: { authorization: `Bearer ${LOCAL_FLOW_INTERNAL_SERVICE_KEY}` },
      signal: AbortSignal.timeout(2_000),
    });
    return (
      (response.status === 200 || response.status === 404) &&
      response.headers.get(LOCAL_TEST_PROFILE_HEADER) === "1"
    );
  } catch {
    return false;
  }
}

export async function localGatewayHealthy(
  gatewayUrl: string,
): Promise<boolean> {
  try {
    const response = await fetch(localEndpoint(gatewayUrl, "local gateway", "/health/live"), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function localWebHealthy(webUrl: string): Promise<boolean> {
  try {
    const baseUrl = assertLoopbackHttpUrl(webUrl, "local web");
    const response = await fetch(new URL("/auth", baseUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureLocalWeb(
  topology: LocalTopology,
  options: { autoStart: boolean; supabase: LocalSupabaseEnvironment },
): Promise<LocalStackHandle> {
  const webPort = topology.marker?.ports.web ?? 3000;
  const webUrl = localWebUrl(webPort);
  if (await localWebHealthy(webUrl)) {
    return { started: false, stop: async () => {} };
  }
  if (!options.autoStart) {
    throw new Error(`local web is not running at ${webUrl}`);
  }

  const { API_URL, ANON_KEY } = options.supabase;
  if (!API_URL || !ANON_KEY) {
    throw new Error("local Supabase environment is incomplete");
  }
  const web = Bun.spawn(
    ["pnpm", "--filter", "Kortix-Computer-Frontend", "dev"],
    {
      cwd: topology.root,
      detached: true,
      env: {
        ...process.env,
        WEB_PORT: String(webPort),
        KORTIX_API_PROXY_TARGET: topology.apiUrl.replace(/\/v1$/, ""),
        NEXT_PUBLIC_BACKEND_URL: topology.apiUrl,
        KORTIX_PUBLIC_BACKEND_URL: topology.apiUrl,
        BACKEND_URL: topology.apiUrl,
        SUPABASE_URL: API_URL,
        NEXT_PUBLIC_SUPABASE_URL: API_URL,
        KORTIX_PUBLIC_SUPABASE_URL: API_URL,
        SUPABASE_ANON_KEY: ANON_KEY,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
        KORTIX_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
        NEXT_PUBLIC_APP_URL: webUrl,
        KORTIX_PUBLIC_APP_URL: webUrl,
        NEXT_PUBLIC_URL: webUrl,
        NEXT_PUBLIC_BILLING_ENABLED: "false",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await localWebHealthy(webUrl)) {
      return {
        started: true,
        stop: async () => stopOwnedStack(web),
      };
    }
    if (web.exitCode !== null) {
      throw new Error(
        `local web exited with code ${web.exitCode} before readiness`,
      );
    }
    await Bun.sleep(250);
  }

  await stopOwnedStack(web);
  throw new Error(`local web did not become ready at ${webUrl} within 180s`);
}

export async function ensureLocalStack(
  topology: LocalTopology,
  options: { autoStart: boolean; supabase: LocalSupabaseEnvironment },
): Promise<LocalStackHandle> {
  const gatewayUrl = `http://127.0.0.1:${topology.marker?.ports.gateway ?? 8090}`;
  const apiWasHealthy = await localApiHealthy(topology.apiUrl);
  const gatewayWasHealthy = await localGatewayHealthy(gatewayUrl);
  if (apiWasHealthy && !(await localApiUsesTestProfile(topology.apiUrl))) {
    throw new Error(
      `local API at ${topology.apiUrl} does not use the deterministic test profile; stop that development stack and rerun pnpm test`,
    );
  }
  if (apiWasHealthy && gatewayWasHealthy) {
    return { started: false, stop: async () => {} };
  }
  if (!options.autoStart) {
    throw new Error(
      `local API is not running at ${topology.apiUrl}; start the stack or omit --no-start`,
    );
  }

  const { DB_URL, API_URL, SERVICE_ROLE_KEY, JWT_SECRET } = options.supabase;
  if (!DB_URL || !API_URL || !SERVICE_ROLE_KEY) {
    throw new Error("local Supabase environment is incomplete");
  }

  const apiPort = topology.marker?.ports.api ?? 8008;
  const webPort = topology.marker?.ports.web ?? 3000;
  const gatewayPort = topology.marker?.ports.gateway ?? 8090;
  const gatewayToken = `ke2e-local-${crypto.randomUUID()}`;
  const owned: Bun.Subprocess[] = [];
  const api = apiWasHealthy
    ? null
    : Bun.spawn(["bun", "--no-env-file", "run", "src/index.ts"], {
        cwd: join(topology.root, "apps/api"),
        detached: true,
        env: {
          ...process.env,
          ENV_MODE: "local",
          INTERNAL_KORTIX_ENV: "dev",
          KORTIX_LOCAL_DEV: "1",
          KORTIX_LOCAL_TEST_PROFILE: "1",
          PORT: String(apiPort),
          KORTIX_APPS_LOCAL: "true",
          KORTIX_APPS_LOCAL_PORT: String(apiPort),
          KORTIX_URL: topology.apiUrl.replace(/\/v1$/, ""),
          NEXT_PUBLIC_BACKEND_URL: topology.apiUrl,
          KORTIX_PUBLIC_BACKEND_URL: topology.apiUrl,
          BACKEND_URL: topology.apiUrl,
          FRONTEND_URL: `http://127.0.0.1:${webPort}`,
          CORS_ALLOWED_ORIGINS: localWebUrl(webPort),
          DATABASE_URL: DB_URL,
          SUPABASE_URL: API_URL,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          API_KEY_SECRET: "local-flow-runner-api-key-secret",
          INTERNAL_SERVICE_KEY: LOCAL_FLOW_INTERNAL_SERVICE_KEY,
          ...(JWT_SECRET ? { SUPABASE_JWT_SECRET: JWT_SECRET } : {}),
          KORTIX_SKIP_ENSURE_SCHEMA: "1",
          SCHEDULER_ENABLED: "false",
          KORTIX_TRIGGER_SCHEDULER_ENABLED: "false",
          KORTIX_WORKERS_ENABLED: "false",
          KORTIX_BILLING_INTERNAL_ENABLED: "true",
          ALLOWED_SANDBOX_PROVIDERS: "platinum,daytona",
          PLATINUM_API_KEY: "local-test-provider-disabled",
          PLATINUM_API_URL: "http://127.0.0.1:1",
          DAYTONA_API_KEY: "local-test-provider-disabled",
          DAYTONA_SERVER_URL: "http://127.0.0.1:1",
          DAYTONA_TARGET: "local-test-provider-disabled",
          STRIPE_SECRET_KEY: "sk_test_local_flow_runner_disabled",
          STRIPE_WEBHOOK_SECRET: "whsec_local_flow_runner_disabled",
          PIPEDREAM_WEBHOOK_SECRET: "local-flow-runner-disabled",
          SLACK_CLIENT_ID: "local-flow-runner-disabled",
          SLACK_CLIENT_SECRET: "local-flow-runner-disabled",
          SLACK_SIGNING_SECRET: "local-flow-runner-disabled",
          LLM_GATEWAY_ENABLED: "true",
          LLM_GATEWAY_BASE_URL: "",
          LLM_GATEWAY_PROXY_PORT: String(gatewayPort),
          GATEWAY_INTERNAL_TOKEN: gatewayToken,
          TUNNEL_ENABLED: "false",
          TUNNEL_SIGNING_SECRET: "local-flow-runner-tunnel-signing-secret",
          EMAIL_PROVIDER_ORDER: "mailpit",
          ...(options.supabase.MAILPIT_URL
            ? { MAILPIT_API_URL: options.supabase.MAILPIT_URL }
            : {}),
          KORTIX_MARKETPLACE_EXTERNAL_ENABLED: "0",
          KORTIX_MODEL_CATALOG_LIVE_ENABLED: "0",
          KORTIX_MODEL_PRICING_LIVE_ENABLED: "0",
        },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
  if (api) owned.push(api);
  const gateway = gatewayWasHealthy
    ? null
    : Bun.spawn(["bun", "run", "src/main.ts"], {
        cwd: join(topology.root, "apps/llm-gateway"),
        detached: true,
        env: {
          ...process.env,
          PORT: String(gatewayPort),
          KORTIX_API_URL: topology.apiUrl.replace(/\/v1$/, ""),
          GATEWAY_INTERNAL_TOKEN: gatewayToken,
          GATEWAY_API_TOKEN: gatewayToken,
          LANGFUSE_PUBLIC_KEY: "",
          LANGFUSE_SECRET_KEY: "",
          GATEWAY_CAPTURE_BODIES: "false",
        },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
  if (gateway) owned.push(gateway);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (
      (await localApiHealthy(topology.apiUrl)) &&
      (await localGatewayHealthy(gatewayUrl))
    ) {
      return {
        started: true,
        stop: async () => stopOwnedProcesses(owned),
      };
    }
    const exited = owned.find((process) => process.exitCode !== null);
    if (exited) {
      await stopOwnedProcesses(owned);
      throw new Error(
        `local process exited with code ${exited.exitCode} before readiness`,
      );
    }
    await Bun.sleep(250);
  }

  await stopOwnedProcesses(owned);
  throw new Error(
    `local API did not become ready at ${topology.apiUrl} within 180s`,
  );
}

async function stopOwnedStack(stack: Bun.Subprocess): Promise<void> {
  if (stack.exitCode !== null) return;
  signalOwnedProcessGroup(stack, "SIGTERM");
  await Promise.race([stack.exited, Bun.sleep(15_000)]);
  if (stack.exitCode === null) {
    signalOwnedProcessGroup(stack, "SIGKILL");
    await stack.exited;
  }
}

function signalOwnedProcessGroup(
  stack: Bun.Subprocess,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-stack.pid, signal);
  } catch {
    stack.kill(signal);
  }
}

async function stopOwnedProcesses(processes: Bun.Subprocess[]): Promise<void> {
  await Promise.all(processes.map((process) => stopOwnedStack(process)));
}
