import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ENTRY = join(resolve(import.meta.dir, "..", ".."), "src", "index.ts");
const PROJECT_ID = "00000000-0000-4000-a000-000000000111";
const ACCOUNT_ID = "00000000-0000-4000-a000-000000000222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

let root = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: Array<{ method: string; path: string; search: string; body: unknown }> = [];
let stored: Record<string, unknown> = {};

const row = (over: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  branch_name: SESSION_ID,
  base_ref: "main",
  sandbox_provider: "daytona",
  sandbox_id: SESSION_ID,
  sandbox_url: null,
  opencode_session_id: null,
  name: "Fix login",
  agent_name: "default",
  status: "running",
  error: null,
  labels: ["bug", "ui"],
  metadata: { ticket: "T-1" },
  created_at: "2026-09-30T00:00:00.000Z",
  updated_at: "2026-09-30T00:00:00.000Z",
  parent_session_id: null,
  initiator: { type: "member", id: "user-1", label: "Ada" },
  ...over,
});

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: join(root, "config.json"),
    KORTIX_NO_UPDATE_CHECK: "1",
    KORTIX_DISABLE_SANDBOX_ENV_FILE: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const key of ["KORTIX_API_URL", "KORTIX_TOKEN", "KORTIX_PROJECT_ID", "KORTIX_SESSION_ID", "BASH_ENV"]) delete env[key];
  Object.assign(env, extraEnv);
  const p = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kortix-sessions-labels-cli-"));
  requests = [];
  stored = row();
  mkdirSync(join(root, ".kortix"), { recursive: true });
  writeFileSync(
    join(root, ".kortix", "link.json"),
    JSON.stringify({ project_id: PROJECT_ID, account_id: ACCOUNT_ID, host: "test", host_url: "http://127.0.0.1", linked_at: "2026-09-30T00:00:00.000Z" }),
  );
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      requests.push({ method: request.method, path: url.pathname, search: url.search, body });
      const list = `/v1/projects/${PROJECT_ID}/sessions`;
      if (url.pathname === list && request.method === "GET") return Response.json([stored, row({ session_id: "33333333-3333-4333-8333-333333333333", name: "Plain", labels: [] })]);
      if (url.pathname === list && request.method === "POST") return Response.json(row({ ...(body as object) }), { status: 201 });
      if (url.pathname === `${list}/${SESSION_ID}` && request.method === "GET") return Response.json(stored);
      if (url.pathname === `${list}/${SESSION_ID}` && request.method === "PATCH") {
        const patch = body as { labels?: string[]; metadata?: Record<string, unknown> };
        const metadata = { ...(stored.metadata as object), ...patch.metadata } as Record<string, unknown>;
        for (const [k, v] of Object.entries(metadata)) if (v === null) delete metadata[k];
        stored = { ...stored, ...(patch.labels ? { labels: patch.labels } : {}), metadata };
        return Response.json(stored);
      }
      return Response.json({ error: "nf" }, { status: 404 });
    },
  });
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      active: "test",
      hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: "t", user_id: "user-1", user_email: "u@example.test", account_id: ACCOUNT_ID, logged_in_at: "2026-09-30T00:00:00.000Z" } },
    }),
  );
});

afterEach(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

const patches = () => requests.filter((r) => r.method === "PATCH");

describe("kortix sessions labels and metadata", () => {
  test("new --label --meta sends labels and string metadata on create", async () => {
    const r = await runCli(["sessions", "new", "--label", "bug", "--label", "ui", "--meta", "ticket=T-1", "--meta", "url=https://x.test/a=b", "--json"]);
    expect(r.code).toBe(0);
    const create = requests.find((q) => q.method === "POST");
    expect(create?.body).toMatchObject({ labels: ["bug", "ui"], metadata: { ticket: "T-1", url: "https://x.test/a=b" } });
  });

  test("new --meta without key=value exits 2 before any request", async () => {
    const r = await runCli(["sessions", "new", "--meta", "ticket"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--meta expects key=value");
    expect(requests).toEqual([]);
  });

  test("ls --label repeats label and prints a LABELS column", async () => {
    const r = await runCli(["sessions", "ls", "--label", "bug", "--label", "customer: eu"]);
    expect(r.code).toBe(0);
    expect(new URLSearchParams(requests[0]!.search).getAll("label")).toEqual(["bug", "customer: eu"]);
    expect(r.stdout).toContain("LABELS");
    expect(r.stdout).toMatch(/Fix login.*bug, ui/);
  });

  test("update adds and removes labels and sets and unsets metadata in one PATCH", async () => {
    const r = await runCli(["sessions", "update", SESSION_ID, "--label", "triaged", "--unlabel", "bug", "--meta", "owner=ada", "--unmeta", "ticket"]);
    expect(r.code).toBe(0);
    expect(patches().map((p) => p.body)).toEqual([{ labels: ["ui", "triaged"], metadata: { owner: "ada", ticket: null } }]);
    expect(r.stdout).toContain("ui, triaged");
    expect(r.stdout).toContain("owner");
  });

  test("update defaults to $KORTIX_SESSION_ID, so an agent labels its own session", async () => {
    const r = await runCli(["sessions", "update", "--label", "needs-review", "--json"], { KORTIX_SESSION_ID: SESSION_ID });
    expect(r.code).toBe(0);
    expect(patches()[0]?.path).toBe(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`);
    expect(JSON.parse(r.stdout).labels).toEqual(["bug", "ui", "needs-review"]);
  });

  test("update --clear-labels sends an empty list and sends no metadata", async () => {
    const r = await runCli(["sessions", "update", SESSION_ID, "--clear-labels"]);
    expect(r.code).toBe(0);
    expect(patches().map((p) => p.body)).toEqual([{ labels: [] }]);
  });

  test("update with nothing to change exits 2 before any request", async () => {
    const r = await runCli(["sessions", "update", SESSION_ID]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Nothing to update");
    expect(requests).toEqual([]);
  });

  test("info prints labels", async () => {
    const r = await runCli(["sessions", "info", SESSION_ID]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/labels\s+bug, ui/);
  });
});
