import { join } from "node:path";
import {
  LOCAL_AUTH_EMAIL_HOOK_SECRET,
  LOCAL_GATEWAY_INTERNAL_TOKEN,
  LOCAL_STRIPE_WEBHOOK_SECRET,
  LOCAL_FLOW_INTERNAL_SERVICE_KEY,
  localWebUrl,
  type LocalSupabaseEnvironment,
} from "./local-profile";
import { assertLoopbackHttpUrl, localEndpoint, type LocalTopology } from "./local-topology";

export * from "./local-topology";
export * from "./local-supabase";

export interface LocalStackHandle {
  started: boolean;
  stop(): Promise<void>;
}

export const LOCAL_TEST_PROFILE_HEADER = "x-kortix-local-test-profile";

async function probeLocalHealth(
  url: string,
  label: string,
  suffix: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(localEndpoint(url, label, suffix), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function localApiHealthy(apiUrl: string): Promise<boolean> {
  return probeLocalHealth(apiUrl, "local API", "/health", 2_000);
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

async function localGatewayHealthy(
  gatewayUrl: string,
): Promise<boolean> {
  return probeLocalHealth(gatewayUrl, "local gateway", "/health/live", 2_000);
}

async function localWebHealthy(webUrl: string): Promise<boolean> {
  return probeLocalHealth(webUrl, "local web", "", 5_000);
}

/**
 * The environment the deterministic local stack hands its Next dev server.
 *
 * Exported as a pure function so the contract is assertable without spawning a
 * process — see local-web-environment.test.ts.
 */
export function localWebEnvironment(options: {
  webPort: number;
  webUrl: string;
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}): Record<string, string> {
  const { webPort, webUrl, apiUrl, supabaseUrl, supabaseAnonKey } = options;
  return {
    WEB_PORT: String(webPort),
    KORTIX_API_PROXY_TARGET: apiUrl.replace(/\/v1$/, ""),
    NEXT_PUBLIC_BACKEND_URL: apiUrl,
    KORTIX_PUBLIC_BACKEND_URL: apiUrl,
    BACKEND_URL: apiUrl,
    SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    KORTIX_PUBLIC_SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: supabaseAnonKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
    KORTIX_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
    NEXT_PUBLIC_APP_URL: webUrl,
    KORTIX_PUBLIC_APP_URL: webUrl,
    NEXT_PUBLIC_URL: webUrl,
    NEXT_PUBLIC_BILLING_ENABLED: "false",
    // A one-shot test run starts with a cold `.next/dev/cache` and deletes it
    // afterwards, so Turbopack's dev filesystem cache saves nothing here. It
    // can still cost the entire browser shard: a failed restore panics outside
    // turbo-tasks' per-task boundary and aborts the dev server, after which
    // every remaining spec fails with ERR_CONNECTION_REFUSED and names itself
    // instead of the real cause. See apps/web/next.config.ts.
    KORTIX_TURBOPACK_FS_CACHE: "off",
  };
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
        ...localWebEnvironment({
          webPort,
          webUrl,
          apiUrl: topology.apiUrl,
          supabaseUrl: API_URL,
          supabaseAnonKey: ANON_KEY,
        }),
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await localWebHealthy(webUrl)) {
      // Nothing watches the dev server once it is ready, so a mid-run death
      // used to reach the report as N unrelated spec failures — each one
      // blaming itself for an ERR_CONNECTION_REFUSED against a dead port, the
      // real cause hundreds of lines earlier in a shared stdout. Say it once,
      // loudly, at the moment it happens.
      let stopping = false;
      void web.exited.then((code) => {
        if (stopping) return;
        console.error(
          `[local-stack] the local web server exited with code ${code} while ` +
            `tests were still running. Every browser spec from this point on ` +
            `will fail against ${webUrl} with a connection error, whatever ` +
            `each one reports. Look above this line for the cause.`,
        );
      });
      return {
        started: true,
        stop: async () => {
          stopping = true;
          await stopOwnedStack(web);
        },
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

  const {
    DB_URL,
    API_URL,
    ANON_KEY,
    SERVICE_ROLE_KEY,
    JWT_SECRET,
    S3_PROTOCOL_ACCESS_KEY_ID,
    S3_PROTOCOL_ACCESS_KEY_SECRET,
  } = options.supabase;
  if (!DB_URL || !API_URL || !SERVICE_ROLE_KEY) {
    throw new Error("local Supabase environment is incomplete");
  }

  const apiPort = topology.marker?.ports.api ?? 8008;
  const webPort = topology.marker?.ports.web ?? 3000;
  const gatewayPort = topology.marker?.ports.gateway ?? 8090;
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
          // Connector flows stand up a loopback upstream (CONN-ATT-1, CONN-EGRESS-1).
          // Only this exact host is exempt from the connector egress check;
          // every other private address stays refused.
          KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: "127.0.0.1",
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
          // Public by design; served by GET /v1/auth/client-config (AUTH-3).
          ...(ANON_KEY ? { SUPABASE_ANON_KEY: ANON_KEY } : {}),
          API_KEY_SECRET: "local-flow-runner-api-key-secret",
          INTERNAL_SERVICE_KEY: LOCAL_FLOW_INTERNAL_SERVICE_KEY,
          ...(JWT_SECRET ? { SUPABASE_JWT_SECRET: JWT_SECRET } : {}),
          // Every access token is confirmed live with GoTrue. TTL 0 sends one
          // GoTrue `/user` call per request; a full core run then exhausts
          // GoTrue's ephemeral DB ports (see the learnings ledger, 2026-10-01).
          // 2 s bounds that to one call per token per 2 s, and logout drops the
          // cached verdict on this single replica at once.
          SUPABASE_JWT_LIVENESS_TTL_MS: "2000",
          KORTIX_SKIP_ENSURE_SCHEMA: "1",
          // Config archives go through the API's one object store, pointed at
          // this profile's Supabase Storage S3 endpoint. `--no-env-file` above
          // means apps/api/.env is NOT read here, so the whole block has to be
          // explicit.
          KORTIX_CONFIG_ARCHIVE_S3_BUCKET: "kortix-config-releases",
          KORTIX_CONFIG_ARCHIVE_S3_REGION: "local",
          KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: `${API_URL.replace(/\/+$/, "")}/storage/v1/s3`,
          KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE: "true",
          ...(S3_PROTOCOL_ACCESS_KEY_ID
            ? { KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID: S3_PROTOCOL_ACCESS_KEY_ID }
            : {}),
          ...(S3_PROTOCOL_ACCESS_KEY_SECRET
            ? { KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY: S3_PROTOCOL_ACCESS_KEY_SECRET }
            : {}),
          SCHEDULER_ENABLED: "false",
          // OAU-7 replays a rotated refresh token after this window; keep it short.
          KORTIX_OAUTH_REFRESH_GRACE_MS: "2000",
          KORTIX_TRIGGER_SCHEDULER_ENABLED: "false",
          KORTIX_WORKERS_ENABLED: "false",
          // The App deploy route kicks its worker directly, so the general
          // switch above does not cover it. Every provider here points at an
          // unreachable address, so a running worker only races a doomed build:
          // on Linux it fails in milliseconds, on macOS the upload hangs. Off,
          // a local deployment stays `queued` and APP-7 is deterministic.
          KORTIX_APPS_WORKER_ENABLED: "false",
          KORTIX_BILLING_INTERNAL_ENABLED: "true",
          ALLOWED_SANDBOX_PROVIDERS: "platinum,daytona",
          PLATINUM_API_KEY: "local-test-provider-disabled",
          PLATINUM_API_URL: "http://127.0.0.1:1",
          DAYTONA_API_KEY: "local-test-provider-disabled",
          DAYTONA_SERVER_URL: "http://127.0.0.1:1",
          DAYTONA_TARGET: "local-test-provider-disabled",
          STRIPE_SECRET_KEY: "sk_test_local_flow_runner_disabled",
          STRIPE_WEBHOOK_SECRET: LOCAL_STRIPE_WEBHOOK_SECRET,
          PIPEDREAM_WEBHOOK_SECRET: "local-flow-runner-disabled",
          SLACK_CLIENT_ID: "local-flow-runner-disabled",
          SLACK_CLIENT_SECRET: "local-flow-runner-disabled",
          SLACK_SIGNING_SECRET: "local-flow-runner-disabled",
          LLM_GATEWAY_ENABLED: "true",
          LLM_GATEWAY_BASE_URL: "",
          LLM_GATEWAY_PROXY_PORT: String(gatewayPort),
          GATEWAY_INTERNAL_TOKEN: LOCAL_GATEWAY_INTERNAL_TOKEN,
          TUNNEL_ENABLED: "true",
          TUNNEL_SIGNING_SECRET: "local-flow-runner-tunnel-signing-secret",
          // One connection string configures delivery, exactly as an operator
          // sets it — so the local suite exercises the EMAIL_URL path itself.
          ...(options.supabase.MAILPIT_URL
            ? {
                EMAIL_URL: `mailpit://${options.supabase.MAILPIT_URL.replace(/^https?:\/\//, "")}`,
              }
            : {}),
          EMAIL_FROM: "Kortix Local <noreply@kortix.local>",
          AUTH_EMAIL_HOOK_SECRET: LOCAL_AUTH_EMAIL_HOOK_SECRET,
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
          GATEWAY_INTERNAL_TOKEN: LOCAL_GATEWAY_INTERNAL_TOKEN,
          GATEWAY_API_TOKEN: LOCAL_GATEWAY_INTERNAL_TOKEN,
          LANGFUSE_PUBLIC_KEY: "",
          LANGFUSE_SECRET_KEY: "",
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
