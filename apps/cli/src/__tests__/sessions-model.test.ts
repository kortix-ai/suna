// `sessions ls --json` and `sessions status --json` carry the session's
// resolved model id — the stored pin (`metadata.opencode_model`, the same
// `provider/model` ref `sessions new --model` takes), or null when the row
// holds none (the session follows the default chain). KRTX-1695.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ENTRY = join(resolve(import.meta.dir, "..", ".."), "src", "index.ts");
const PROJECT_ID = "00000000-0000-4000-a000-000000000111";
const ACCOUNT_ID = "00000000-0000-4000-a000-000000000222";
const PINNED_ID = "11111111-1111-4111-8111-111111111111";
const UNPINNED_ID = "22222222-2222-4222-8222-222222222222";
const BYOK_ID = "33333333-3333-4333-8333-333333333333";

let root = "";
let server: ReturnType<typeof Bun.serve> | null = null;

const row = (id: string, over: Record<string, unknown> = {}) => ({
  session_id: id,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  branch_name: "b",
  base_ref: "main",
  sandbox_provider: "daytona",
  sandbox_id: id,
  sandbox_url: null,
  opencode_session_id: null,
  name: `Session ${id.slice(0, 8)}`,
  agent_name: "default",
  status: "completed",
  error: null,
  metadata: {},
  created_at: "2026-10-06T00:00:00.000Z",
  updated_at: "2026-10-06T00:00:00.000Z",
  parent_session_id: null,
  initiator: { type: "member", id: "user-1", label: "Ada" },
  ...over,
});

const PINNED = row(PINNED_ID, {
  status: "running",
  metadata: { opencode_model: "kortix/glm-5.3-flash", opencode_model_source: "project" },
});
const UNPINNED = row(UNPINNED_ID);
const BYOK = row(BYOK_ID, { metadata: { opencode_model: "openai/gpt-4o" } });

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
  root = mkdtempSync(join(tmpdir(), "kortix-sessions-model-cli-"));
  mkdirSync(join(root, ".kortix"), { recursive: true });
  writeFileSync(
    join(root, ".kortix", "link.json"),
    JSON.stringify({ project_id: PROJECT_ID, account_id: ACCOUNT_ID, host: "test", host_url: "http://127.0.0.1", linked_at: "2026-10-06T00:00:00.000Z" }),
  );
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/v1/projects/${PROJECT_ID}/sessions`) {
        return Response.json([PINNED, UNPINNED, BYOK]);
      }
      // `sessions status` wakes each running session before it reads activity;
      // a ready answer keeps that path fast and the runtime read 404s into the
      // caught "unknown activity" branch, which does not affect the model field.
      if (url.pathname.endsWith("/start")) {
        return Response.json({ stage: "ready", runtime_session_id: "runtime-1", sandbox: { external_id: "sbx-1" } });
      }
      return Response.json({ error: "nf" }, { status: 404 });
    },
  });
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      active: "test",
      hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: "t", user_id: "user-1", user_email: "u@example.test", account_id: ACCOUNT_ID, logged_in_at: "2026-10-06T00:00:00.000Z" } },
    }),
  );
});

afterEach(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("kortix sessions model field in --json output", () => {
  test("ls --json carries the stored pin per session and null when unpinned", async () => {
    const r = await runCli(["sessions", "ls", "--json"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.session_id === PINNED_ID)).toMatchObject({ model: "kortix/glm-5.3-flash" });
    expect(rows.find((x) => x.session_id === BYOK_ID)).toMatchObject({ model: "openai/gpt-4o" });
    expect(rows.find((x) => x.session_id === UNPINNED_ID)).toMatchObject({ model: null });
  });

  test("status --json carries the model per session", async () => {
    const r = await runCli(["sessions", "status", "--all", "--json"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.session_id === PINNED_ID)).toMatchObject({ model: "kortix/glm-5.3-flash" });
    expect(rows.find((x) => x.session_id === BYOK_ID)).toMatchObject({ model: "openai/gpt-4o" });
    expect(rows.find((x) => x.session_id === UNPINNED_ID)).toMatchObject({ model: null });
  });
});
