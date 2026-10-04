import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ENTRY = join(resolve(import.meta.dir, "..", ".."), "src", "index.ts");
const PROJECT_ID = "00000000-0000-4000-a000-000000000111";
const ACCOUNT_ID = "00000000-0000-4000-a000-000000000222";
const PARENT_ID = "11111111-1111-4111-8111-111111111111";

let root = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let queries: string[] = [];

const row = (over: Record<string, unknown>) => ({
  session_id: PARENT_ID,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  branch_name: "b",
  base_ref: "main",
  sandbox_provider: "daytona",
  sandbox_id: PARENT_ID,
  sandbox_url: null,
  opencode_session_id: null,
  name: "Nightly sweep",
  agent_name: "default",
  status: "running",
  error: null,
  metadata: {},
  created_at: "2026-08-03T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
  parent_session_id: null,
  initiator: { type: "trigger", id: "nightly", label: "nightly" },
  child_count: 12,
  ...over,
});

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: join(root, "config.json"),
    KORTIX_NO_UPDATE_CHECK: "1",
    KORTIX_DISABLE_SANDBOX_ENV_FILE: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const key of ["KORTIX_API_URL", "KORTIX_TOKEN", "KORTIX_PROJECT_ID", "BASH_ENV"]) delete env[key];
  const p = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kortix-sessions-ls-cli-"));
  queries = [];
  mkdirSync(join(root, ".kortix"), { recursive: true });
  writeFileSync(
    join(root, ".kortix", "link.json"),
    JSON.stringify({ project_id: PROJECT_ID, account_id: ACCOUNT_ID, host: "test", host_url: "http://127.0.0.1", linked_at: "2026-08-03T00:00:00.000Z" }),
  );
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== `/v1/projects/${PROJECT_ID}/sessions`) return Response.json({ error: "nf" }, { status: 404 });
      queries.push(url.search);
      if (url.searchParams.get("parent") === PARENT_ID) {
        return Response.json([row({ session_id: "22222222-2222-4222-8222-222222222222", name: "worker", parent_session_id: PARENT_ID, child_count: undefined, initiator: { type: "member", id: "user-1", label: "Ada" } })]);
      }
      return Response.json([
        row({}),
        row({ session_id: "33333333-3333-4333-8333-333333333333", name: "Mine", child_count: 0, initiator: { type: "member", id: "user-1", label: "Ada" } }),
      ]);
    },
  });
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      active: "test",
      hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: "t", user_id: "user-1", user_email: "u@example.test", account_id: ACCOUNT_ID, logged_in_at: "2026-08-03T00:00:00.000Z" } },
    }),
  );
});

afterEach(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("kortix sessions ls attribution", () => {
  test("default stays the flat list and shows STARTED BY", async () => {
    const r = await runCli(["sessions", "ls"]);
    expect(r.code).toBe(0);
    expect(queries).toEqual([""]);
    expect(r.stdout).toContain("STARTED BY");
  });

  test("--mine lists top-level sessions with STARTED BY and CHILDREN", async () => {
    const r = await runCli(["sessions", "ls", "--mine"]);
    expect(r.code).toBe(0);
    expect(queries).toEqual(["?parent=root&started_by=me"]);
    expect(r.stdout).toContain("STARTED BY");
    expect(r.stdout).toContain("CHILDREN");
    expect(r.stdout).toMatch(/Nightly sweep\s+nightly\s+12/);
    expect(r.stdout).toMatch(/Mine\s+you\s+0/);
  });

  test("--automated --search sends started_by and q; --json keeps the new fields", async () => {
    const r = await runCli(["sessions", "ls", "--automated", "--search", "sweep", "--json"]);
    expect(r.code).toBe(0);
    expect(queries).toEqual(["?parent=root&started_by=automated&q=sweep"]);
    expect(JSON.parse(r.stdout)[0]).toMatchObject({ child_count: 12, initiator: { label: "nightly" } });
  });

  test("--children expands a short id and lists that parent's children", async () => {
    const r = await runCli(["sessions", "ls", "--children", PARENT_ID.slice(0, 8)]);
    expect(r.code).toBe(0);
    expect(queries.at(-1)).toBe(`?parent=${PARENT_ID}`);
    expect(r.stdout).toMatch(/worker\s+you/);
    expect(r.stdout).not.toContain("CHILDREN");
  });

  test("--mine with --shared exits 2 without calling the API", async () => {
    const r = await runCli(["sessions", "ls", "--mine", "--shared"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("only one of --mine, --shared, --automated");
    expect(queries).toEqual([]);
  });
});
