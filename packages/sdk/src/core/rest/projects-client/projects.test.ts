import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type CreateProjectRepoInput,
  type KortixProject,
  type ProjectInput,
  type ProvisionProjectInput,
  createProjectRepo,
  getProject,
  getProjectDetail,
  provisionProject,
  provisionProjectWithToken,
  updateProject,
} from './projects';

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
