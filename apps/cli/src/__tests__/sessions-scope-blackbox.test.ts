import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ENTRY = join(resolve(import.meta.dir, "..", ".."), "src", "index.ts");
const PROJECT_ID = "00000000-0000-4000-a000-000000000111";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "00000000-0000-4000-a000-000000000222";

let root = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: Array<{ method: string; path: string; body?: unknown }> = [];

const currentScope = {
  secrets_allowlist: ["CURRENT_SECRET"],
  required_connectors: ["gmail"],
  connector_bindings: { gmail: { connection_id: "AUTH-CURRENT" } },
  dropped_secrets: [],
  added_secrets: [],
  dropped_bindings: [],
  retroactive: true,
  detail: "Current session scope.",
};

function session() {
  return {
    session_id: SESSION_ID,
    account_id: ACCOUNT_ID,
    workspace_id: PROJECT_ID,
    branch_name: SESSION_ID,
    base_ref: "main",
    sandbox_provider: "daytona",
    sandbox_id: SESSION_ID,
    sandbox_url: null,
    opencode_session_id: null,
    name: "Scope target",
    agent_name: "default",
    status: "running",
    error: null,
    metadata: {},
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T00:00:00.000Z",
  };
}

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: join(root, "config.json"),
    KORTIX_NO_UPDATE_CHECK: "1",
    KORTIX_DISABLE_SANDBOX_ENV_FILE: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const key of [
    "KORTIX_API_URL",
    "KORTIX_CLI_TOKEN",
    "KORTIX_PROJECT_ID",
    "KORTIX_TOKEN",
    "BASH_ENV",
  ]) {
    delete env[key];
  }
  const processHandle = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => processHandle.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kortix-session-scope-cli-"));
  requests = [];
  mkdirSync(join(root, ".kortix"), { recursive: true });
  writeFileSync(
    join(root, ".kortix", "link.json"),
    JSON.stringify({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      host: "test",
      host_url: "http://127.0.0.1",
      linked_at: "2026-08-03T00:00:00.000Z",
    }),
  );
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const entry: { method: string; path: string; body?: unknown } = {
        method: request.method,
        path: url.pathname,
      };
      if (request.method === "PUT") entry.body = await request.json();
      requests.push(entry);
      if (
        request.method === "GET" &&
        url.pathname === `/v1/workspaces/${PROJECT_ID}/sessions`
      ) {
        return Response.json([session()]);
      }
      if (
        request.method === "GET" &&
        url.pathname === `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}`
      ) {
        return Response.json(session());
      }
      if (
        request.method === "GET" &&
        url.pathname ===
          `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}/scope`
      ) {
        return Response.json(currentScope);
      }
      if (
        request.method === "PUT" &&
        url.pathname ===
          `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}/scope`
      ) {
        const body = entry.body as {
          secrets?: string[] | null;
          connector_bindings?: Record<string, { connection_id: string }>;
          require_connectors?: string[] | null;
        };
        const requiredConnectors = Object.hasOwn(body, "require_connectors")
          ? body.require_connectors?.length
            ? body.require_connectors
            : null
          : currentScope.required_connectors;
        return Response.json({
          ...currentScope,
          secrets_allowlist: body.secrets ?? currentScope.secrets_allowlist,
          required_connectors: requiredConnectors,
          connector_bindings:
            body.connector_bindings ?? currentScope.connector_bindings,
          dropped_secrets: ["CURRENT_SECRET"],
          added_secrets: body.secrets ?? [],
          dropped_bindings: ["gmail"],
          retroactive: false,
          detail: "Changes apply to the next prompt.",
        });
      }
      return Response.json(
        { error: `not found ${url.pathname}` },
        { status: 404 },
      );
    },
  });
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      active: "test",
      hosts: {
        test: {
          url: `http://127.0.0.1:${server.port}`,
          token: "test-token",
          user_id: "user-1",
          user_email: "user@example.test",
          account_id: ACCOUNT_ID,
          logged_in_at: "2026-08-03T00:00:00.000Z",
        },
      },
    }),
  );
});

afterEach(() => {
  server?.stop(true);
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("kortix sessions scope", () => {
  test("limits the create-time backend-token notice to secret flags", async () => {
    const result = await runCli(["sessions", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Session access at creation:");
    expect(result.stdout).toContain("backend token required");
    expect(result.stdout).not.toContain(
      "Backend overrides (require a backend token",
    );
    expect(requests).toEqual([]);
  });

  test("reads the authoritative scope as JSON", async () => {
    const result = await runCli(["sessions", "scope", SESSION_ID, "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(currentScope);
    expect(requests).toEqual([
      {
        method: "GET",
        path: `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}`,
      },
      {
        method: "GET",
        path: `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}/scope`,
      },
    ]);
  });

  test("expands the short id printed by sessions ls before the scope request", async () => {
    const result = await runCli(["sessions", "scope", SESSION_ID.slice(0, 8), "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(currentScope);
    expect(requests).toEqual([
      { method: "GET", path: `/v1/workspaces/${PROJECT_ID}/sessions` },
      { method: "GET", path: `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}/scope` },
    ]);
  });

  test("replaces each requested scope category through one atomic request", async () => {
    const result = await runCli([
      "sessions",
      "scope",
      SESSION_ID,
      "--secret",
      "MAIL_KEY",
      "--secret",
      "BILLING_KEY",
      "--connector",
      "gmail=AUTH-NEW",
      "--require-connector",
      "slack",
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      secrets_allowlist: ["MAIL_KEY", "BILLING_KEY"],
      required_connectors: ["slack"],
      connector_bindings: { gmail: { connection_id: "AUTH-NEW" } },
      retroactive: false,
    });
    expect(requests.at(-1)).toEqual({
      method: "PUT",
      path: `/v1/workspaces/${PROJECT_ID}/sessions/${SESSION_ID}/scope`,
      body: {
        secrets: ["MAIL_KEY", "BILLING_KEY"],
        connector_bindings: { gmail: { connection_id: "AUTH-NEW" } },
        require_connectors: ["slack"],
      },
    });
  });

  test("supports explicit inherited and empty scope states", async () => {
    const result = await runCli([
      "sessions",
      "scope",
      SESSION_ID,
      "--inherit-secrets",
      "--no-connectors",
      "--no-required-connectors",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("required   None");
    expect(result.stdout).toContain("Changes apply to the next prompt.");
    expect(result.stdout).toContain(
      "Secret values already read cannot be removed from existing context.",
    );
    expect(requests.at(-1)?.body).toEqual({
      secrets: null,
      connector_bindings: {},
      require_connectors: [],
    });
  });

  test("leaves omitted categories unchanged", async () => {
    const result = await runCli([
      "sessions",
      "scope",
      SESSION_ID,
      "--no-secrets",
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(requests.at(-1)?.body).toEqual({ secrets: [] });
  });

  test("rejects conflicting secret modes before a network request", async () => {
    const result = await runCli([
      "sessions",
      "scope",
      SESSION_ID,
      "--secret",
      "MAIL_KEY",
      "--no-secrets",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Choose one secrets mode");
    expect(requests).toEqual([]);
  });
});
