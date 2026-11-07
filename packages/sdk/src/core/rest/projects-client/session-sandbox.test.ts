import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { configureKortix } from "../../http/config";
import { clearSessionFresh, markSessionFresh } from "../../http/fresh-sessions";
import { clearSessionRuntime, getSessionRuntime,
} from "../../session/session-runtime-registry";
import { isSessionStartError,
  projectSessionStartSeed,
  sessionStartKey, startWorkspaceSession, startWorkspaceSessionOrThrow,
} from "./session-sandbox";
import type { SessionStartImageState, SessionStartImageStep } from "./session-sandbox";
import type { ProjectSession } from "./sessions";

const PROJECT = "P1";
const SESSION = "S1";

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? "GET",
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { "content-type": "application/json" },
    });
  },
  ) as unknown as typeof fetch;
});

afterEach(() => {
  clearSessionRuntime(PROJECT, SESSION);
  clearSessionFresh(SESSION);
});

configureKortix({ backendUrl: "http://test.local/v1", getToken: async () => "tok",
});
const last = () => calls[calls.length - 1];

function readySandbox(overrides: Partial<{ external_id: string | null }> = {}) {
  return {
    sandbox_id: "sbx-db-1",
    session_id: SESSION,
    project_id: PROJECT,
    account_id: "acct-1",
    provider: "daytona" as const,
    external_id: "ext-1",
    base_url: null,
    status: "active" as const,
    config: {},
    metadata: {},
    last_used_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("projectSessionStartSeed turns a running inventory row into a ready cache seed", () => {
  const row = {
    session_id: SESSION,
    project_id: PROJECT,
    account_id: "acct-1",
    branch_name: SESSION,
    base_ref: "main",
    sandbox_id: "sbx-db-1",
    sandbox_provider: "daytona",
    sandbox_url: "http://test.local/v1/p/ext-1/8000",
    runtime_session_id: "oc-1",
    name: null,
    custom_name: null,
    agent_name: "default",
    status: "running",
    error: null,
    metadata: { source: "ui" },
    runtime_sessions: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  } satisfies ProjectSession;

  expect(projectSessionStartSeed(row)).toEqual({
    stage: "ready",
    agent_name: "default",
    retriable: true,
    sandbox: {
      sandbox_id: "sbx-db-1",
      session_id: SESSION,
      project_id: PROJECT,
      account_id: "acct-1",
      provider: "daytona",
      external_id: "ext-1",
      base_url: "http://test.local/v1/p/ext-1/8000",
      status: "active",
      config: {},
      metadata: { source: "ui" },
      last_used_at: "2026-01-02T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    },
    runtime_session_id: "oc-1",
    runtime_url: "http://test.local/v1/p/ext-1/8000",
  });
});

test("projectSessionStartSeed rejects stale or incomplete inventory rows", () => {
  const base = {
    session_id: SESSION,
    project_id: PROJECT,
    account_id: "acct-1",
    branch_name: SESSION,
    base_ref: "main",
    sandbox_id: "sbx-db-1",
    sandbox_provider: "daytona",
    sandbox_url: "http://test.local/v1/p/ext-1/8000",
    runtime_session_id: "oc-1",
    name: null,
    custom_name: null,
    agent_name: null,
    status: "running",
    error: null,
    metadata: {},
    runtime_sessions: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  } satisfies ProjectSession;

  expect(projectSessionStartSeed({ ...base, status: "stopped" })).toBeNull();
  expect(
    projectSessionStartSeed({ ...base, runtime_session_id: null }),
  ).toBeNull();
  expect(projectSessionStartSeed({ ...base, sandbox_url: null })).toBeNull();
  // A legacy Suna-migration row is minted with `sandbox_id = null` and
  // provisioning only writes `sandbox_url`, so a running, fully-wired row can
  // still carry a null id. The seed MUST drop it — otherwise the session page
  // derefs `sandbox.sandbox_id.slice(0, 8)` and crashes (BS e6d0e044).
  // (`sandbox_id` is typed `string` but the DB column is nullable — the runtime
  // null is exercised through a cast, mirroring what the API actually serves.)
  expect(
    projectSessionStartSeed({ ...base, sandbox_id: null as unknown as string }),
  ).toBeNull();
  expect(projectSessionStartSeed({ ...base, sandbox_id: "" })).toBeNull();
});

test("startProjectSession POSTs to /start with no query string when waitMs is omitted", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "provisioning", agent_name: "default", retriable: true, sandbox: null, runtime_session_id: null,
    },
  };
  await startWorkspaceSession(PROJECT, SESSION);
  expect(last().url).toBe(`http://test.local/v1/workspaces/${PROJECT}/sessions/${SESSION}/start`,
  );
  expect(last().method).toBe("POST");
  expect(last().body).toEqual({});
});

test("startProjectSession appends ?wait_ms=<floored ms> when waitMs is given", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "provisioning", agent_name: "default", retriable: true, sandbox: null, runtime_session_id: null,
    },
  };
  await startWorkspaceSession(PROJECT, SESSION, 5_500.9);
  expect(last().url).toContain("/start?wait_ms=5500");
});

test("startProjectSession explicitly requests the preserved previous-repository runtime", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "starting", agent_name: "default", retriable: true, sandbox: null, runtime_session_id: null },
  };
  await startWorkspaceSession(PROJECT, SESSION, {
    waitMs: 5_500.9,
    repositoryMode: "previous",
  });
  expect(last().url).toBe(
    `http://test.local/v1/workspaces/${PROJECT}/sessions/${SESSION}/start?wait_ms=5500&repository_mode=previous`,
  );
});

test("startProjectSession keepStopped asks the API to report a stopped box, never wake it", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "stopped", agent_name: "default", retriable: false, sandbox: null, runtime_session_id: null },
  };
  await startWorkspaceSession(PROJECT, SESSION, { waitMs: 15_000, keepStopped: true });
  expect(last().url).toBe(
    `http://test.local/v1/workspaces/${PROJECT}/sessions/${SESSION}/start?wait_ms=15000&keep_stopped=1`,
  );
  await startWorkspaceSession(PROJECT, SESSION, { waitMs: 15_000 });
  expect(last().url).not.toContain("keep_stopped");
});

test("startProjectSession omits the query string for a zero or negative waitMs", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "provisioning", agent_name: "default", retriable: true, sandbox: null, runtime_session_id: null,
    },
  };
  await startWorkspaceSession(PROJECT, SESSION, 0);
  expect(last().url).not.toContain("wait_ms");

  await startWorkspaceSession(PROJECT, SESSION, -100);
  expect(last().url).not.toContain("wait_ms");
});

test("startProjectSession throws a terminal SessionStartError for non-retryable client errors", async () => {
  nextResponse = { status: 404, body: { error: "Not found" } };

  let caught: unknown;
  try {
    await startWorkspaceSession(PROJECT, SESSION);
  } catch (error) {
    caught = error;
  }

  expect(isSessionStartError(caught)).toBe(true);
  expect((caught as Error & { status?: number; terminal?: boolean }).status,
  ).toBe(404);
  expect((caught as Error & { status?: number; terminal?: boolean }).terminal,
  ).toBe(true);
});

test("startProjectSession returns null on 404 for a fresh session (create-vs-start race) so the poll continues", async () => {
  markSessionFresh(SESSION);
  nextResponse = { status: 404, body: { error: "Not found" } };

  const result = await startWorkspaceSession(PROJECT, SESSION);
  expect(result).toBeNull();
});

test("startProjectSession still throws terminally on non-404 client errors for a fresh session", async () => {
  markSessionFresh(SESSION);
  nextResponse = { status: 403, body: { error: "Forbidden" } };

  let caught: unknown;
  try {
    await startWorkspaceSession(PROJECT, SESSION);
  } catch (error) {
    caught = error;
  }

  expect(isSessionStartError(caught)).toBe(true);
  expect((caught as Error & { status?: number }).status).toBe(403);
});

test("startProjectSession returns null for server failures so callers can retry", async () => {
  nextResponse = { status: 500, body: { message: "boom" } };
  const result = await startWorkspaceSession(PROJECT, SESSION);
  expect(result).toBeNull();
});

test("startProjectSession returns null when the response has no data", async () => {
  nextResponse = { status: 200, body: null };
  const result = await startWorkspaceSession(PROJECT, SESSION);
  expect(result).toBeNull();
});

test("startProjectSession returns the parsed result even when stage is not ready (no registry write)", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "starting", agent_name: "default", retriable: true, sandbox: readySandbox(), runtime_session_id: null,
    },
  };
  const result = await startWorkspaceSession(PROJECT, SESSION);
  expect(result?.stage).toBe("starting");
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test("startProjectSession returns the provisioning boot's image step as the server sent it", async () => {
  const image: SessionStartImageStep = {
    state: "building",
    image: "kortix-session-v42",
    since: "2026-11-02T10:00:00.000Z",
  };
  nextResponse = {
    status: 200,
    body: {
      stage: "provisioning",
      agent_name: "default",
      retriable: true,
      sandbox: null,
      runtime_session_id: null,
      boot: { phase: "provisioning", since: "2026-11-02T09:59:58.000Z", actively_starting: true, image },
    },
  };
  const result = await startWorkspaceSession(PROJECT, SESSION);
  const state: SessionStartImageState | undefined = result?.boot?.image?.state;
  expect(state).toBe("building");
  expect(result?.boot?.image).toEqual(image);
});

test("startProjectSession populates the shared session-runtime registry once stage is ready with a sandbox external_id + runtime_session_id", async () => {
  nextResponse = {
    status: 200,
    body: {
      stage: "ready",
      agent_name: "default",
      retriable: false,
      sandbox: readySandbox({ external_id: "ext-ready-1" }),
      runtime_session_id: "ocs-ready-1",
    },
  };
  const result = await startWorkspaceSession(PROJECT, SESSION);
  expect(result?.stage).toBe("ready");

  const entry = getSessionRuntime(PROJECT, SESSION);
  expect(entry).toBeDefined();
  expect(entry?.opencodeSessionId).toBe("ocs-ready-1");
  expect(entry?.runtimeSessionId).toBe("ocs-ready-1");
  expect(entry?.sandboxId).toBe("ext-ready-1");
  expect(entry?.runtimeUrl).toBe("http://test.local/v1/p/ext-ready-1/8000");
});

test("startProjectSession does NOT populate the registry when ready but sandbox has no external_id", async () => {
  nextResponse = {
    status: 200,
    body: {
      stage: "ready",
      agent_name: "default",
      retriable: false,
      sandbox: readySandbox({ external_id: null }),
      runtime_session_id: "ocs-2",
    },
  };
  await startWorkspaceSession(PROJECT, SESSION);
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test("startProjectSession does NOT populate the registry when ready but runtime_session_id is missing", async () => {
  nextResponse = {
    status: 200,
    body: {
      stage: "ready",
      agent_name: "default",
      retriable: false,
      sandbox: readySandbox({ external_id: "ext-3" }),
      runtime_session_id: null,
    },
  };
  await startWorkspaceSession(PROJECT, SESSION);
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test("startProjectSession does NOT populate the registry when ready but sandbox itself is null", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "ready", agent_name: "default", retriable: false, sandbox: null, runtime_session_id: "ocs-4",
    },
  };
  await startWorkspaceSession(PROJECT, SESSION);
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test("sessionStartKey returns a stable tuple keyed by project + session id", () => {
  expect(sessionStartKey("PA", "SA")).toEqual(["session-start", "PA", "SA"]);
  expect(sessionStartKey("PA", "SA")).toEqual(sessionStartKey("PA", "SA"));
  expect(sessionStartKey("PA", "SA")).not.toEqual(sessionStartKey("PB", "SA"));
});

test("startProjectSessionOrThrow resolves the start answer and records a ready runtime", async () => {
  nextResponse = {
    status: 200,
    body: { stage: "ready", agent_name: "default", retriable: false, sandbox: readySandbox(), runtime_session_id: "rt-1" },
  };
  const result = await startWorkspaceSessionOrThrow(PROJECT, SESSION, { waitMs: 5000 });
  expect(last()).toMatchObject({ method: "POST", url: "http://test.local/v1/workspaces/P1/sessions/S1/start?wait_ms=5000" });
  expect(result.stage).toBe("ready");
  expect(getSessionRuntime(PROJECT, SESSION)?.runtimeSessionId).toBe("rt-1");
});

test("startProjectSessionOrThrow rejects on a transient 503 where startProjectSession yields null", async () => {
  nextResponse = { status: 503, body: { error: "provider unavailable" } };
  expect(await startWorkspaceSession(PROJECT, SESSION)).toBeNull();
  const error = await startWorkspaceSessionOrThrow(PROJECT, SESSION).catch((e: unknown) => e);
  expect((error as { status?: number }).status).toBe(503);
});

test("startProjectSessionOrThrow keeps the billing detail of a 402 for the upgrade gate", async () => {
  nextResponse = {
    status: 402,
    body: { message: "Out of credits", code: "insufficient_credits", account_id: "acct-1", balance: 0 },
  };
  const error = (await startWorkspaceSessionOrThrow(PROJECT, SESSION).catch((e: unknown) => e)) as {
    status?: number;
    detail?: { code?: string; account_id?: string };
  };
  expect(error.status).toBe(402);
  expect(error.detail?.code).toBe("insufficient_credits");
  expect(error.detail?.account_id).toBe("acct-1");
});
