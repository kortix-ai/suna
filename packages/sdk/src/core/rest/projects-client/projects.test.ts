import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  type CreateProjectRepoInput,
  FEATURE_FLAG_KEYS,
  type ExperimentalFeatureKey,
  type ExperimentalFeatureView,
  type FeatureFlagKey,
  type FeatureFlagView,
  type KortixProject,
  type ProjectInput,
  type ProvisionPhase,
  type ProvisionProjectInput,
  type ProvisionStreamEvent,
  createProjectRepo,
  getProject,
  getProjectDetail,
  provisionProject,
  provisionProjectStream,
  provisionProjectWithToken,
  updateExperimentalFeature,
  updateFeatureFlag,
  updateProject,
} from './projects';

test('ExperimentalFeatureKey includes the project-scoped Apps gate', () => {
  const feature: ExperimentalFeatureKey = 'apps';
  expect(feature).toBe('apps');
});

let nextResponse: () => Response = () => new Response('{}', { status: 200 });

beforeEach(() => {
  globalThis.fetch = mock(async () => nextResponse()) as unknown as typeof fetch;
});

const opts = { backendUrl: 'http://backend.test/v1', accessToken: 'tok' };
const input = { account_id: 'acc-1', name: 'My First Project', seed_starter: true };

test('GitHub project creation accepts a marketplace project template', () => {
  const createInput: CreateProjectRepoInput = {
    account_id: 'acc-1',
    name: 'support-agent',
    source_item_id: 'kortix-projects:support-agent-kit',
  };

  expect(createInput.source_item_id).toBe('kortix-projects:support-agent-kit');
});

test('CreateProjectRepoInput accepts an optional icon', () => {
  const createInput: CreateProjectRepoInput = {
    account_id: 'acc-1',
    name: 'support-agent',
    icon: '🚀',
  };

  expect(createInput.icon).toBe('🚀');
});

test('CreateProjectRepoInput accepts an optional icon_glyph', () => {
  const createInput: CreateProjectRepoInput = {
    account_id: 'acc-1',
    name: 'support-agent',
    icon_glyph: { name: 'Rocket', color: 'blue' },
  };

  expect(createInput.icon_glyph).toEqual({ name: 'Rocket', color: 'blue' });
});

test('createProjectRepo sends icon_glyph on the wire, same as provision and link-repository', async () => {
  // The type-level test above only proves `CreateProjectRepoInput` accepts the
  // field on a locally-built object — it stays green even if `createProjectRepo`
  // silently dropped `icon_glyph` before POSTing. This asserts what actually
  // reaches `fetch`, matching the wire assertion `provisionProject` gets
  // ("icon_glyph is sent on provision", above) and `linkRepository` gets
  // (github.test.ts, "sends the icon_glyph in the request body when linking a
  // repository").
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await createProjectRepo({
    account_id: 'acc-1',
    name: 'support-agent',
    icon_glyph: { name: 'Rocket', color: 'blue' },
  });

  expect(sentBody).toMatchObject({ icon_glyph: { name: 'Rocket', color: 'blue' } });
});

test('CreateProjectRepoInput carries project_name, the workspace name distinct from the repo name', () => {
  // `POST /projects/create-repo` reads TWO names (apps/api/src/projects/routes/
  // r2.ts): `name` is the GitHub repository name, charset-validated against
  // /^[a-zA-Z0-9._-]+$/, and `project_name` is the Kortix workspace name, which
  // falls back to `deriveProjectName(repo.full_name)` when absent. Without this
  // field a caller whose user typed "Ana's agents" must slugify for `name` and
  // then has no way to keep the typed name — the workspace lands as
  // "Ana-s-agents". Optional, so every existing caller keeps compiling.
  const input: CreateProjectRepoInput = {
    account_id: 'acc-1',
    name: 'ana-s-agents',
    project_name: "Ana's agents",
  };
  expect(input.project_name).toBe("Ana's agents");
});

test('createProjectRepo sends project_name on the wire', async () => {
  // Paired wire assertion, same reasoning as the icon_glyph pair above: the
  // type-level test proves the field is ACCEPTED, this one proves it is not
  // dropped before the POST.
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await createProjectRepo({
    account_id: 'acc-1',
    name: 'ana-s-agents',
    project_name: "Ana's agents",
  });

  expect(sentBody).toMatchObject({ name: 'ana-s-agents', project_name: "Ana's agents" });
});

test('returns ok:true with the parsed project on a real 200 body', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ project_id: 'proj-1', name: 'My First Project' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result.ok).toBe(true);
  expect(result.ok && result.project.project_id).toBe('proj-1');
});

test('provisionProject applies the caller timeout to slow managed-git provisioning', async () => {
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
  });
  globalThis.fetch = mock(
    async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ project_id: 'proj-too-late' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            ),
          50,
        );
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  ) as unknown as typeof fetch;

  await expect(
    provisionProject(
      { account_id: 'acc-1', name: 'Slow Project', seed_starter: true },
      { timeout: 5 },
    ),
  ).rejects.toMatchObject({
    code: 'TIMEOUT',
    endpoint: '/projects/provision',
    timeout: 5,
  });
});

// Regression: a 200 whose body has no project_id used to be reported as a
// fake success — the caller would build an unusable `/projects/undefined` path.
test('reports not-ok when the response is 200 but the body has no project_id', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ name: 'My First Project' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: false });
});

test('reports not-ok when the 200 body is not valid JSON', async () => {
  nextResponse = () => new Response('not json', { status: 200 });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: false });
});

test('reports limitReached on a 403 with the project_limit_reached code', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ code: 'project_limit_reached' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: true });
});

test('returns ok:false without hitting the network when credentials are missing', async () => {
  const calls: unknown[] = [];
  globalThis.fetch = mock(async (...args: unknown[]) => {
    calls.push(args);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const result = await provisionProjectWithToken({ backendUrl: '', accessToken: '' }, input);
  expect(result).toEqual({ ok: false, limitReached: false });
  expect(calls).toHaveLength(0);
});

test('normalizes the provider-neutral default_agent field from legacy project config', async () => {
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
  });
  nextResponse = () =>
    new Response(
      JSON.stringify({
        project: { project_id: 'proj-1' },
        config: {
          open_code_default_agent: 'kortix',
          agents: [],
          commands: [],
          skills: [],
          env: { required: [], optional: [] },
        },
        file_count: 0,
        files: [],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );

  const detail = await getProjectDetail('proj-1');

  expect(detail.config.default_agent).toBe('kortix');
  expect(detail.config.open_code_default_agent).toBe('kortix');
});

// getProjectDetail goes through backendApi/unwrap — the same parsing path
// createProject, getProject, and updateProject use to return a KortixProject.
// provisionProjectWithToken (covered above) bypasses backendApi entirely with
// its own explicit-token fetch, so it does not exercise this path.
test('a project response carries the icon through the backendApi/unwrap parsing path', async () => {
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
  });
  nextResponse = () =>
    new Response(
      JSON.stringify({
        project: { project_id: 'proj-1', name: 'Iconic', icon: '🚀' },
        config: {
          open_code_default_agent: null,
          agents: [],
          commands: [],
          skills: [],
          env: { required: [], optional: [] },
        },
        file_count: 0,
        files: [],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );

  const detail = await getProjectDetail('proj-1');

  expect(detail.project.icon).toBe('🚀');
});

test('provisionProject sends the icon in the request body', async () => {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await provisionProject({ account_id: 'acc-1', name: 'Iconic', icon: '🚀' });

  expect(sentBody).toMatchObject({ icon: '🚀' });
});

test('a project response carries the icon through to KortixProject', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ project_id: 'proj-1', name: 'Iconic', icon: '🚀' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, { ...input, icon: '🚀' });

  expect(result.ok).toBe(true);
  expect(result.ok && result.project.icon).toBe('🚀');
});

// ── B44: `icon` on the updateProject body ────────────────────────────────────
//
// `PATCH /v1/projects/:projectId` reads THREE states off `icon`, and only the
// request body can tell them apart (apps/api/src/projects/routes/r5.ts):
//
//   key absent  → the stored icon is left alone
//   icon: null  → the stored icon is removed
//   icon: "🚀"  → the stored icon is replaced
//
// So the type has to carry `null`, and — more importantly — the `null` has to
// SURVIVE serialization all the way onto the wire. `JSON.stringify` drops
// `undefined` members silently; any layer that normalised nullish the same way
// would turn "remove the icon" into "leave it alone" with every type check
// still green. These tests read the body the mocked `fetch` was actually
// handed, not the object handed to `updateProject`.

/** Runs `updateProject` against a mocked fetch and returns what it sent. */
async function captureUpdate(input: Partial<ProjectInput>) {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let request: { url: string; method?: string; body: string } | undefined;
  globalThis.fetch = mock(async (target: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(target), method: init?.method, body: String(init?.body ?? '') };
    return new Response(JSON.stringify({ project_id: 'proj-1', name: 'Iconic', icon: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await updateProject('proj-1', input);

  // Guard the guard: every assertion below is vacuous if fetch was never
  // called, and `undefined.body` would read as a confusing TypeError.
  expect(request).toBeDefined();
  return {
    ...request!,
    // The RAW string, parsed here — not the input object echoed back.
    parsed: JSON.parse(request!.body || '{}') as Record<string, unknown>,
  };
}

test('updateProject PATCHes the project route', async () => {
  const sent = await captureUpdate({ name: 'Iconic' });

  expect(sent.method).toBe('PATCH');
  expect(sent.url).toBe('http://backend.test/v1/projects/proj-1');
});

test('updateProject puts an explicit null icon on the wire, not an absent key', async () => {
  const sent = await captureUpdate({ icon: null });

  // Both halves matter. `parsed.icon === null` alone passes when the key was
  // dropped (missing reads as undefined only under `!=`), and `'icon' in
  // parsed` alone passes when the value was rewritten to something else.
  expect('icon' in sent.parsed).toBe(true);
  expect(sent.parsed.icon).toBeNull();
  // The literal wire bytes. A serializer that emitted `"icon":{}` or omitted
  // the member entirely would still satisfy a lenient object comparison.
  expect(sent.body).toContain('"icon":null');
});

test('updateProject sends a chosen emoji verbatim', async () => {
  const sent = await captureUpdate({ icon: '👨‍👩‍👧‍👦' });

  expect(sent.parsed.icon).toBe('👨‍👩‍👧‍👦');
});

test('a name-only update sends NO icon key, so the stored icon survives', async () => {
  const sent = await captureUpdate({ name: 'Renamed only' });

  expect(sent.parsed).toEqual({ name: 'Renamed only' });
  expect('icon' in sent.parsed).toBe(false);
});

test('updateProject can send a name and an icon in one body', async () => {
  const sent = await captureUpdate({ name: 'Renamed', icon: '🎯' });

  expect(sent.parsed).toEqual({ name: 'Renamed', icon: '🎯' });
});

/**
 * Compile-time pin on the RESPONSE half of the clear, checked by `tsc --noEmit`
 * and not by `bun test`. Assigning INTO the member is what pins it: reading it
 * out into a `string | null | undefined` compiles either way, so only this
 * direction fails if `KortixProject['icon']` is ever narrowed to `string`.
 *
 * A clear is only useful if the caller can SEE that it happened — the project
 * card re-renders its lettered fallback from exactly this field. Found while
 * mutation-testing B44: narrowing `KortixProject.icon` to `string` left every
 * runtime assertion here green, because `expect(x).toBeNull()` accepts any type.
 */
const projectIconAcceptsNull: KortixProject['icon'] = null;

test('a project response with a null icon reaches the caller as null', async () => {
  expect(projectIconAcceptsNull).toBeNull();

  // The clear round-trips: the row this PATCH returns has no icon, and the
  // caller re-renders the lettered fallback from exactly this field.
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ project_id: 'proj-1', name: 'Iconic', icon: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

  const project = await updateProject('proj-1', { icon: null });

  expect(project.icon).toBeNull();
});

// ── B45: `icon_glyph` on the project types ───────────────────────────────────
//
// The second, named-glyph icon: `{name, color} | null`, additive alongside
// the emoji `icon` B43/B44 already cover. Same tri-state contract on the
// updateProject body — omit leaves the stored glyph alone, `null` removes it,
// an object replaces it (and clears `icon` server-side; not this package's
// concern to prove, only to type correctly).

test('icon_glyph round-trips on a project read', async () => {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
  nextResponse = () =>
    new Response(
      JSON.stringify({
        project_id: 'proj-1',
        name: 'Glyphic',
        icon_glyph: { name: 'Rocket', color: 'blue' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const project = await getProject('proj-1');

  expect(project.icon_glyph).toEqual({ name: 'Rocket', color: 'blue' });
});

test('icon_glyph is sent on provision', async () => {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await provisionProject({
    account_id: 'acc-1',
    name: 'x',
    icon_glyph: { name: 'Star', color: 'red' },
  });

  expect(sentBody).toMatchObject({ icon_glyph: { name: 'Star', color: 'red' } });
});

test('idempotency_key is sent on provision', async () => {
  // POST /projects/provision mints a brand-new managed repo per call. The key
  // is how a caller makes a retry (second tab, reload, lost response) return
  // the project the first call already created instead of a duplicate — so it
  // has to survive `provisionProject`'s body construction, not just typecheck.
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await provisionProject({
    account_id: 'acc-1',
    name: 'My First Project',
    idempotency_key: 'onboarding-8f1c0f6e-1a2b-4c3d-9e8f-000000000001',
  });

  expect(sentBody).toMatchObject({
    idempotency_key: 'onboarding-8f1c0f6e-1a2b-4c3d-9e8f-000000000001',
  });
});

test('ProvisionProjectInput accepts an optional idempotency_key', () => {
  const withKey: ProvisionProjectInput = {
    account_id: 'acc-1',
    name: 'My First Project',
    idempotency_key: 'onboarding-8f1c0f6e-1a2b-4c3d-9e8f-000000000001',
  };
  const without: ProvisionProjectInput = { name: 'My First Project' };

  expect(withKey.idempotency_key).toBe('onboarding-8f1c0f6e-1a2b-4c3d-9e8f-000000000001');
  expect('idempotency_key' in without).toBe(false);
});

test('updateProject distinguishes omitted icon_glyph from null', () => {
  // Same three-way contract `icon` already documents: omit to leave alone,
  // null to remove, an object to replace. `updateProject`'s real body type is
  // `Partial<ProjectInput>` (see its signature below) — `ProjectInput` itself
  // requires `repo_url`, so that's what a bare `{}` would fail against.
  const omitted: Partial<ProjectInput> = {};
  const cleared: Partial<ProjectInput> = { icon_glyph: null };
  expect('icon_glyph' in omitted).toBe(false);
  expect(cleared.icon_glyph).toBeNull();
});

test('updateProject puts an explicit null icon_glyph on the wire, not an absent key', async () => {
  const sent = await captureUpdate({ icon_glyph: null });

  expect('icon_glyph' in sent.parsed).toBe(true);
  expect(sent.parsed.icon_glyph).toBeNull();
  expect(sent.body).toContain('"icon_glyph":null');
});

test('updateProject sends a chosen glyph verbatim', async () => {
  const sent = await captureUpdate({ icon_glyph: { name: 'Rocket', color: 'blue' } });

  expect(sent.parsed.icon_glyph).toEqual({ name: 'Rocket', color: 'blue' });
});

test('a name-only update sends NO icon_glyph key, so the stored glyph survives', async () => {
  const sent = await captureUpdate({ name: 'Renamed only' });

  expect(sent.parsed).toEqual({ name: 'Renamed only' });
  expect('icon_glyph' in sent.parsed).toBe(false);
});

/**
 * Compile-time pin on the RESPONSE half of the clear — same rationale as
 * `projectIconAcceptsNull` above, found necessary during B44's mutation pass:
 * narrowing `KortixProject.icon` to `string` left every runtime assertion
 * green because `expect(x).toBeNull()` accepts any type. Assigning INTO the
 * member is what pins it.
 */
const projectIconGlyphAcceptsNull: KortixProject['icon_glyph'] = null;

test('a project response with a null icon_glyph reaches the caller as null', async () => {
  expect(projectIconGlyphAcceptsNull).toBeNull();

  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ project_id: 'proj-1', name: 'Glyphic', icon_glyph: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

  const project = await updateProject('proj-1', { icon_glyph: null });

  expect(project.icon_glyph).toBeNull();
});

// ── B-default-branch: `default_branch` on `ProvisionProjectInput` ───────────
//
// Carried Minor: apps/web sends `default_branch` on provision and the server
// (apps/api/src/projects/routes/r1.ts:546) reads it, but the SDK's
// `ProvisionProjectInput` never declared it — forcing a double-cast at the
// web call site. Additive only: a new optional field, no existing member
// touched.

test('ProvisionProjectInput accepts an optional default_branch', () => {
  const withBranch: ProvisionProjectInput = {
    name: 'My First Project',
    default_branch: 'develop',
  };
  const without: ProvisionProjectInput = { name: 'My First Project' };

  expect(withBranch.default_branch).toBe('develop');
  expect('default_branch' in without).toBe(false);
});

test('provisionProject sends default_branch on the wire', async () => {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await provisionProject({ account_id: 'acc-1', name: 'x', default_branch: 'develop' });

  expect(sentBody).toMatchObject({ default_branch: 'develop' });
});

// ── provisionProjectStream ───────────────────────────────────────────────────
//
// POST /projects/provision-stream reports the same create as provisionProject,
// but as a series of data-only SSE frames (`data: {"type":…}\n\n`, no `event:`
// line — see apps/api/src/projects/routes/r1.ts). Frame parsing is line-by-line
// on purpose: SSE allows `: comment` lines and, in principle, an `event:` line
// ahead of `data:`; a parser that hard-fails on any frame that isn't EXACTLY
// `data: <json>` breaks on the first spec-legal frame a server adds.

/**
 * A `fetch` that streams `chunks` as SEPARATE `enqueue()` calls, in order —
 * so a test can force a frame boundary, a JSON body, or a multi-byte UTF-8
 * character to land split across two (or more) reads, matching how a real
 * network actually delivers bytes. A string chunk is UTF-8-encoded whole;
 * pass a raw `Uint8Array` chunk to split a multi-byte character mid-sequence
 * (a plain string chunk can't express "half a codepoint").
 */
function stubStreamingFetch(chunks: Array<string | Uint8Array>) {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
          }
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

describe('provisionProjectStream', () => {
  test('is exported', () => {
    expect(typeof provisionProjectStream).toBe('function');
  });

  test('reports each phase in order and resolves with the project', async () => {
    const seen: string[] = [];
    const body = [
      'data: {"type":"phase","phase":"validating"}\n\n',
      'data: {"type":"phase","phase":"creating_repository"}\n\n',
      'data: {"type":"phase","phase":"registering"}\n\n',
      'data: {"type":"phase","phase":"seeding"}\n\n',
      'data: {"type":"done","project":{"project_id":"p1","name":"suna-web"}}\n\n',
    ].join('');

    const project = await provisionProjectStream(
      { name: 'suna-web' },
      (event) => {
        if (event.type === 'phase') seen.push(event.phase);
      },
      { fetch: stubStreamingFetch([body]) },
    );

    expect(seen).toEqual(['validating', 'creating_repository', 'registering', 'seeding']);
    expect(project.project_id).toBe('p1');
  });

  test('rejects with the server error when the stream ends in an error event', async () => {
    const body = 'data: {"type":"error","error":"Owner or admin role required"}\n\n';
    await expect(
      provisionProjectStream({ name: 'x' }, () => {}, { fetch: stubStreamingFetch([body]) }),
    ).rejects.toThrow('Owner or admin role required');
  });

  test('rejects when the stream closes with no terminal event', async () => {
    await expect(
      provisionProjectStream({ name: 'x' }, () => {}, { fetch: stubStreamingFetch([]) }),
    ).rejects.toThrow();
  });

  // Not in the brief's draft, added for robustness: the parser must be
  // defensive to frames that aren't a bare `data: <json>` line — an SSE
  // comment line (`: …`) and a leading `event:` line are both spec-legal and
  // must be skipped rather than treated as a parse failure.
  test('skips SSE comment and event lines instead of failing on them', async () => {
    const body = [
      ': keep-alive\n\n',
      'event: phase\ndata: {"type":"phase","phase":"validating"}\n\n',
      'data: {"type":"done","project":{"project_id":"p1","name":"suna-web"}}\n\n',
    ].join('');
    const seen: string[] = [];

    const project = await provisionProjectStream(
      { name: 'suna-web' },
      (event) => {
        if (event.type === 'phase') seen.push(event.phase);
      },
      { fetch: stubStreamingFetch([body]) },
    );

    expect(seen).toEqual(['validating']);
    expect(project.project_id).toBe('p1');
  });

  // ── Chunk-boundary reassembly ────────────────────────────────────────────
  //
  // packages/sdk/CLAUDE.md calls streaming "the single most breakable surface
  // in this package" precisely because chunk boundaries over a real network
  // are unpredictable — a frame can split anywhere, including mid-JSON and
  // mid-codepoint. Every test above delivers its whole body in ONE
  // `enqueue()`, so none of them exercise the `buffer +=` / `{ stream: true }`
  // reassembly logic at all; a refactor that dropped `{ stream: true }` or
  // broke the `\n\n` boundary search would stay green against all of them.
  // These pin the reassembly itself, not just the single-chunk happy path.

  test('reassembles a frame split mid-JSON across two chunks', async () => {
    const frame = 'data: {"type":"done","project":{"project_id":"p1","name":"suna-web"}}\n\n';
    const splitPoint = frame.indexOf('"project_id"') + 5; // land inside the JSON body

    const project = await provisionProjectStream({ name: 'x' }, () => {}, {
      fetch: stubStreamingFetch([frame.slice(0, splitPoint), frame.slice(splitPoint)]),
    });

    expect(project.project_id).toBe('p1');
    expect(project.name).toBe('suna-web');
  });

  test('reassembles a frame split mid multi-byte UTF-8 character across two chunks', async () => {
    // 🚀 is U+1F680, a 4-byte UTF-8 sequence. Splitting it in half is exactly
    // what `decoder.decode(value, { stream: true })` exists to survive —
    // without `{ stream: true }` the decoder emits a replacement character
    // (U+FFFD) for the truncated half and `JSON.parse` fails.
    const name = 'suna-🚀';
    const frame = `data: ${JSON.stringify({ type: 'done', project: { project_id: 'p1', name } })}\n\n`;
    const bytes = new TextEncoder().encode(frame);
    const emojiByteOffset = new TextEncoder().encode(frame.slice(0, frame.indexOf('🚀'))).length;
    const splitPoint = emojiByteOffset + 2; // split the 4-byte emoji sequence in half

    const project = await provisionProjectStream({ name: 'x' }, () => {}, {
      fetch: stubStreamingFetch([bytes.slice(0, splitPoint), bytes.slice(splitPoint)]),
    });

    expect(project.name).toBe(name);
  });

  test('parses two frames delivered in a single chunk', async () => {
    const seen: string[] = [];
    const combinedChunk = [
      'data: {"type":"phase","phase":"validating"}\n\n',
      'data: {"type":"phase","phase":"creating_repository"}\n\n',
    ].join('');

    const project = await provisionProjectStream(
      { name: 'x' },
      (event) => {
        if (event.type === 'phase') seen.push(event.phase);
      },
      {
        fetch: stubStreamingFetch([
          combinedChunk,
          'data: {"type":"done","project":{"project_id":"p1"}}\n\n',
        ]),
      },
    );

    expect(seen).toEqual(['validating', 'creating_repository']);
    expect(project.project_id).toBe('p1');
  });

  test('reassembles a single frame split across three chunks', async () => {
    const frame = 'data: {"type":"done","project":{"project_id":"p1","name":"suna-web"}}\n\n';
    const third = Math.ceil(frame.length / 3);
    const chunks = [frame.slice(0, third), frame.slice(third, third * 2), frame.slice(third * 2)];

    const project = await provisionProjectStream({ name: 'x' }, () => {}, {
      fetch: stubStreamingFetch(chunks),
    });

    expect(project.project_id).toBe('p1');
    expect(project.name).toBe('suna-web');
  });

  // ── Malformed frame ───────────────────────────────────────────────────────

  test('wraps a JSON parse failure with context, and still cancels the reader', async () => {
    let cancelled = false;
    const stub = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {this is not json}\n\n'));
            // Deliberately left open — no controller.close(). A stream that
            // is already closed would make a real `reader.cancel()` and a
            // no-op look identical; leaving it open is what proves the
            // cancel algorithm actually ran.
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );

    await expect(provisionProjectStream({ name: 'x' }, () => {}, { fetch: stub })).rejects.toThrow(
      'provisionProjectStream: received an unparseable SSE frame',
    );

    expect(cancelled).toBe(true);
  });

  // Guards the pre-stream denial path documented in
  // apps/api/src/projects/routes/r1.ts: an unauthorized caller gets a plain
  // JSON 403, never a 200 SSE stream carrying an error frame. The client must
  // not silently hang or resolve undefined when the response never opens a
  // stream body at all.
  test('rejects when the initial response is not ok and carries no stream', async () => {
    const stub = async () =>
      new Response(JSON.stringify({ error: 'Owner or admin role required' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });

    await expect(provisionProjectStream({ name: 'x' }, () => {}, { fetch: stub })).rejects.toThrow(
      'Owner or admin role required',
    );
  });

  // ── Final-review FIX 1 ───────────────────────────────────────────────────
  //
  // Every failure `provisionProjectStream` threw used to be a bare `new
  // Error(message)` — no `.status`, no `.code`, even though the server sends
  // both (`apps/api/src/projects/routes/r1.ts`'s error frame, and the
  // pre-stream denial body) and `apps/web`'s `messageFor`/`isRetryableError`
  // (`use-create-workspace.ts`) classify EVERY create failure by reading
  // exactly those two fields. On the streaming path — the one every user
  // takes by default — those classifiers silently saw `undefined` for both,
  // so a 400 got an unwinnable "Try again" and a 409 leaked the literal
  // string "idempotency_key" to the user. These two tests prove the thrown
  // error now carries `status`/`code` matching `ApiError`'s shape
  // (`packages/sdk/src/core/http/api/errors.ts`), so the SAME host
  // classifiers work identically whether the create went through the stream
  // or the plain POST fallback.

  test('FIX 1: an in-band error frame propagates status and code onto the thrown error', async () => {
    const body =
      'data: {"type":"error","error":"Another provision with this idempotency_key is in flight","code":"provision_in_flight","status":409}\n\n';
    let caught: unknown;
    try {
      await provisionProjectStream({ name: 'x' }, () => {}, { fetch: stubStreamingFetch([body]) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).code).toBe('provision_in_flight');
    expect((caught as ApiError).message).toBe(
      'Another provision with this idempotency_key is in flight',
    );
  });

  test('FIX 1: a pre-stream denial (non-2xx, no stream ever opened) propagates status and code the same way', async () => {
    const stub = async () =>
      new Response(JSON.stringify({ error: 'name is required', code: 'invalid_name' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    let caught: unknown;
    try {
      await provisionProjectStream({ name: 'x' }, () => {}, { fetch: stub });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).code).toBe('invalid_name');
    expect((caught as ApiError).message).toBe('name is required');
  });

  test('FIX 1: a pre-stream denial with no code still carries status, and the message stays exactly the server text', async () => {
    const stub = async () =>
      new Response(JSON.stringify({ error: 'Owner or admin role required' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    let caught: unknown;
    try {
      await provisionProjectStream({ name: 'x' }, () => {}, { fetch: stub });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
    expect((caught as ApiError).code).toBeUndefined();
    expect((caught as ApiError).message).toBe('Owner or admin role required');
  });

  test('the phase union matches the API contract exactly', () => {
    const phases: ProvisionPhase[] = [
      'validating',
      'creating_repository',
      'registering',
      'seeding',
    ];
    // Compile-time: any added or renamed member breaks this assignment.
    const exhaustive: Record<ProvisionPhase, true> = {
      validating: true,
      creating_repository: true,
      registering: true,
      seeding: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...phases].sort());
  });

  // Replaces an earlier version of this test that only constructed three
  // `ProvisionStreamEvent` literals and asserted `event.type === 'x'` — true
  // by construction, already guaranteed by the type checker, and exercising
  // no code under test. This version drives a REAL runtime `switch` and
  // proves each arm is actually reached for each of the three wire shapes,
  // which the compiler cannot guarantee on its own.
  test('a runtime switch over ProvisionStreamEvent.type reaches all three wire shapes', () => {
    const describeEvent = (event: ProvisionStreamEvent): string => {
      switch (event.type) {
        case 'phase':
          return `phase:${event.phase}`;
        case 'done':
          return `done:${event.project.project_id}`;
        case 'error':
          return `error:${event.error}`;
      }
    };

    expect(describeEvent({ type: 'phase', phase: 'validating' })).toBe('phase:validating');
    expect(describeEvent({ type: 'done', project: { project_id: 'p1' } as KortixProject })).toBe(
      'done:p1',
    );
    expect(describeEvent({ type: 'error', error: 'boom', code: 'x' })).toBe('error:boom');
  });
});

// ── Feature flags (canonical naming) ────────────────────────────────────────
//
// The platform calls the system "Feature flags"; `Experimental*` survives only
// as a deprecated alias family. These pin the canonical names, the runtime key
// list (which lets other packages assert they have not drifted from the SDK),
// and the two DIFFERENT wire paths the two functions must keep using.

test('FEATURE_FLAG_KEYS lists every flag key exactly once', () => {
  const expected: FeatureFlagKey[] = [
    'agent_tunnel',
    'agentmail_email',
    'apps',
    'connectors_api_discover',
    'llm_gateway',
    'marketplace',
    'meta_agent',
    'monitoring',
    'monitors',
    'review_center',
    'secrets_egress',
    'pi_worker',
    'teams',
    'warm_sessions',
  ];
  expect([...FEATURE_FLAG_KEYS].sort()).toEqual(expected.sort());
  expect(new Set(FEATURE_FLAG_KEYS).size).toBe(FEATURE_FLAG_KEYS.length);
});

test('FEATURE_FLAG_KEYS members are assignable to FeatureFlagKey', () => {
  // A compile-time assertion with a runtime witness: if the runtime list and
  // the hand-written union drift, this stops typechecking.
  const keys: readonly FeatureFlagKey[] = FEATURE_FLAG_KEYS;
  const one: FeatureFlagKey = 'review_center';
  expect(keys).toContain(one);
});

test('FeatureFlagView stability accepts stable, beta, and experimental', () => {
  const stabilities: FeatureFlagView['stability'][] = ['experimental', 'beta', 'stable'];
  expect(stabilities).toHaveLength(3);
});

test('ExperimentalFeatureKey and ExperimentalFeatureView stay as aliases', () => {
  const key: ExperimentalFeatureKey = 'apps';
  const legacy: ExperimentalFeatureView = {
    key,
    name: 'Apps',
    description: 'x',
    stability: 'stable',
    available: true,
    enabled: false,
    overridden: false,
  };
  const canonical: FeatureFlagView = legacy;
  expect(canonical.key).toBe('apps');
});

async function captureFeatureCall(
  run: () => Promise<unknown>,
): Promise<{ url: string; method?: string; body: string; parsed: Record<string, unknown> }> {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let request: { url: string; method?: string; body: string } | undefined;
  globalThis.fetch = mock(async (target: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(target), method: init?.method, body: String(init?.body ?? '') };
    return new Response(JSON.stringify({ project_id: 'proj-1', name: 'Flagged' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await run();

  expect(request).toBeDefined();
  return { ...request!, parsed: JSON.parse(request!.body || '{}') as Record<string, unknown> };
}

test('updateFeatureFlag PATCHes the canonical /features route', async () => {
  const sent = await captureFeatureCall(() => updateFeatureFlag('proj-1', 'review_center', true));

  expect(sent.method).toBe('PATCH');
  expect(sent.url).toBe('http://backend.test/v1/projects/proj-1/features');
  expect(sent.parsed).toEqual({ feature: 'review_center', enabled: true });
});

test('updateFeatureFlag puts an explicit null enabled on the wire, not an absent key', async () => {
  const sent = await captureFeatureCall(() => updateFeatureFlag('proj-1', 'review_center', null));

  // Both halves matter: `parsed.enabled === null` alone passes when the key was
  // dropped; `'enabled' in parsed` alone passes when the value was rewritten.
  expect('enabled' in sent.parsed).toBe(true);
  expect(sent.parsed.enabled).toBeNull();
  expect(sent.body).toContain('"enabled":null');
});

test('updateExperimentalFeature keeps its legacy /experimental wire path', async () => {
  // Older deployed APIs only serve `/experimental`. Repointing this alias at
  // the canonical route would break every consumer pinned to an old server.
  const sent = await captureFeatureCall(() => updateExperimentalFeature('proj-1', 'apps', false));

  expect(sent.url).toBe('http://backend.test/v1/projects/proj-1/experimental');
  expect(sent.parsed).toEqual({ feature: 'apps', enabled: false });
});
