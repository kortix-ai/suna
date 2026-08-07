import { beforeEach, expect, mock, test } from "bun:test";

process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.API_KEY_SECRET ??= "test-api-key-secret";
process.env.TUNNEL_SIGNING_SECRET ??= "test-tunnel-signing-secret";
process.env.ALLOWED_SANDBOX_PROVIDERS = "platinum";
process.env.PLATINUM_API_KEY = "pt_test_key";
process.env.PLATINUM_API_URL = "https://api.platinum.dev";
process.env.PLATINUM_TEMPLATE = "tpl_test";
process.env.KORTIX_URL ??= "https://api.example.com";
process.env.DATABASE_URL ??= "postgres://x";

let calls: Array<{
  path: string;
  method: string;
  body?: Record<string, unknown>;
}> = [];
let startError: Error | null = null;
let sandboxState = "running";

mock.module("../../shared/platinum", () => ({
  isPlatinumConfigured: () => true,
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const body = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ path, method: String(init.method ?? "GET"), body });
    if (path.endsWith("/start") && startError) throw startError;
    if (path.endsWith("/exec"))
      return { result: { stdout: "", stderr: "", exit_code: 0 } };
    if (path === "/v1/sandboxes/sbx_app")
      return { id: "sbx_app", state: sandboxState };
    return {};
  },
}));
mock.module("../service-key", () => ({
  serviceKeyForExternalId: () => "svc_key",
}));
mock.module("../sandbox-frontend-url", () => ({
  sandboxFrontendBaseUrl: () => "https://app.example.com",
}));

const { PlatinumProvider } = await import("./platinum");

beforeEach(() => {
  calls = [];
  startError = null;
  sandboxState = "running";
});

test("ensureAppRuntimeStarted launches appd daemon directly without user-image shell dependencies", async () => {
  const provider = new PlatinumProvider();

  await provider.ensureAppRuntimeStarted("sbx_app");

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    path: "/v1/sandboxes/sbx_app/exec",
    method: "POST",
  });
  expect(calls[0]?.body?.timeout_ms).toBe(15_000);
  expect(calls[0]?.body?.cmd).toEqual(["/kortix/bin/kortix-appd", "--daemon"]);
});

test("ensureAppRuntimeStarted remains idempotent when the hosting layer calls it twice", async () => {
  const provider = new PlatinumProvider();

  await provider.ensureAppRuntimeStarted("sbx_app");
  await provider.ensureAppRuntimeStarted("sbx_app");

  expect(calls).toHaveLength(2);
  expect(calls[0]?.body?.cmd).toEqual(calls[1]?.body?.cmd);
});

test("start treats a running conflict as an idempotent success", async () => {
  startError = new Error(
    'platinum POST /v1/sandboxes/sbx_app/start -> 409 {"error":"sandbox not stopped/archived","state":"running","code":"conflict"}',
  );
  const provider = new PlatinumProvider();

  await expect(provider.start("sbx_app")).resolves.toBeUndefined();

  expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([
    { path: "/v1/sandboxes/sbx_app/start", method: "POST" },
    { path: "/v1/sandboxes/sbx_app", method: "GET" },
  ]);
});

test("start preserves a conflict when the sandbox is not running", async () => {
  startError = new Error(
    'platinum POST /v1/sandboxes/sbx_app/start -> 409 {"error":"conflict","state":"stopping","code":"conflict"}',
  );
  sandboxState = "stopping";
  const provider = new PlatinumProvider();

  await expect(provider.start("sbx_app")).rejects.toThrow(/409/);
  expect(calls.some((call) => call.path === "/v1/sandboxes/sbx_app")).toBe(
    true,
  );
});
