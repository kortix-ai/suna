/**
 * Sandbox runtime assets — `/v1/runtime-assets` (apps/api/src/runtime-assets/).
 * Maps 1:1 to spec §0 "Sandbox runtime assets" (RTA-*).
 *
 * These routes are how a long-lived sandbox stops running a `kortix` CLI older
 * than the API it calls, so the black-box properties worth proving are: authed
 * and not public, the manifest is decision-grade on its own, and the two payload
 * routes are content-addressed so a converged sandbox transfers nothing. The
 * ~100 MB binary body is deliberately never downloaded here — the 304 is the
 * assertion that matters, and a flow that pulls 100 MB per run is a tax on every
 * CI lane.
 *
 * Read-only, no fixtures, no sandboxes.
 */
import { flow } from '../core/flow';
import { isKe2eRetryableError } from '../core/client';
import { waitFor } from '../core/poll';
import { markSessionReadinessTimeoutRetryable } from '../core/session-runtime-retry';
import type { CreatedProject, FlowContext } from '../core/types';

async function createProjectPat(ctx: FlowContext, label: string) {
  const project = await ctx.fixtures.project();
  const response = await ctx.client.as(ctx.P.OWNER).post(
    '/v1/projects/:projectId/cli-token',
    { name: ctx.fixtures.name(label) },
    { params: { projectId: project.id } },
  );
  response.status(201).body().exists('$.secret_key').exists('$.token_id');
  const body = response.json<{ secret_key: string; token_id: string }>();
  ctx.track('token', body.token_id);
  return ctx.client.withBearer(body.secret_key, 'PAT_PROJ');
}

const SHA256 = /^[0-9a-f]{64}$/;

flow(
  'RTA-1',
  {
    domain: 'runtime-assets',
    tags: ['smoke'],
    routes: [
      'GET /v1/runtime-assets/manifest',
      'GET /v1/runtime-assets/agent',
      'HEAD /v1/runtime-assets/agent',
      'POST /v1/projects/:projectId/cli-token',
    ],
  },
  async (ctx) => {
    const projectPat = await createProjectPat(ctx, 'runtime-assets-manifest-pat');

    await ctx.step('ANON cannot read the runtime-asset manifest', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/runtime-assets/manifest');
      r.status(401);
    });

    await ctx.step('a PROJECT-scoped PAT can read it — this is the in-sandbox daemon', async () => {
      // The KORTIX_TOKEN injected into every sandbox is a project+session
      // scoped PAT, and that is the only caller this route exists for. An owner
      // JWT passing proves nothing about a sandbox.
      const r = await projectPat.get('/v1/runtime-assets/manifest');
      r.status(200);
    });

    await ctx.step('the manifest alone is enough to decide whether to download', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/runtime-assets/manifest');
      r.status(200).body().exists('$.managed_skills_hash').exists('$.managed_skills_count');
      const body = r.json<{
        cli_version: string | null;
        cli_sha256: string | null;
        cli_size: number | null;
        managed_skills_hash: string;
        managed_skills_count: number;
      }>();
      if (!SHA256.test(body.managed_skills_hash)) {
        throw new Error(`managed_skills_hash must be a sha256 hex digest, got ${body.managed_skills_hash}`);
      }
      if (!(body.managed_skills_count > 0)) {
        throw new Error('the overlay must contain at least one managed skill file');
      }
      // The CLI half is nullable by design: a checkout that never built
      // apps/cli/dist/kortix must null it rather than fail the whole manifest.
      // When it IS present, all three fields must be present together — a
      // digest without a size is not actionable.
      if (body.cli_sha256 !== null) {
        if (!SHA256.test(body.cli_sha256)) {
          throw new Error(`cli_sha256 must be a sha256 hex digest, got ${body.cli_sha256}`);
        }
        if (!(typeof body.cli_size === 'number' && body.cli_size > 0)) {
          throw new Error('cli_size must accompany a non-null cli_sha256');
        }
      } else if (body.cli_size !== null) {
        throw new Error('cli_size must be null when cli_sha256 is null');
      }
    });

    await ctx.step('the v2 component block describes the whole runtime, not just the CLI', async () => {
      // A box converges its daemon and its opencode off this block. If the
      // component list regresses to CLI-only, every sandbox silently stops
      // self-healing and nothing else in the system notices.
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/runtime-assets/manifest');
      r.status(200);
      const body = r.json<{
        build: number;
        components: Record<string, { sha256?: string; size?: number; version?: string | null; source?: string }>;
        policy: { agent_self_update: boolean };
      }>();
      if (typeof body.build !== 'number') {
        throw new Error('build must be a number — a sandbox uses it to refuse going backwards');
      }
      if (typeof body.policy?.agent_self_update !== 'boolean') {
        throw new Error('policy.agent_self_update must be a boolean kill switch');
      }
      const opencode = body.components?.opencode;
      if (!opencode?.version) {
        throw new Error('components.opencode.version is what a stale box converges onto');
      }
      const agent = body.components?.agent;
      // Nullable by design, exactly like the CLI half: a checkout that never
      // built the daemon must omit it rather than fail the manifest.
      if (agent && agent.sha256 && !SHA256.test(agent.sha256)) {
        throw new Error(`components.agent.sha256 must be a sha256 hex digest, got ${agent.sha256}`);
      }
    });

    await ctx.step('the agent binary is downloadable and matches its advertised digest', async () => {
      const manifest = await ctx.client.as(ctx.P.OWNER).get('/v1/runtime-assets/manifest');
      manifest.status(200);
      const agent = manifest.json<{ components?: { agent?: { sha256?: string; size?: number } } }>()
        .components?.agent;
      if (!agent?.sha256) return; // no daemon built in this profile — nothing to serve

      const anon = await ctx.client.as(ctx.P.ANON).get('/v1/runtime-assets/agent');
      anon.status(401);

      // HEAD via the generic request seam — the client exposes no `head()`
      // helper, and HEAD is the call a daemon makes to check the digest without
      // pulling ~95 MB it may already have.
      const head = await ctx.client.as(ctx.P.OWNER).request('HEAD', '/v1/runtime-assets/agent');
      head.status(200);
      if (head.header('x-kortix-agent-sha256') !== agent.sha256) {
        throw new Error('the agent route must advertise the same digest the manifest promises');
      }
    });

    await ctx.step('the manifest is stable — two reads of one deploy agree', async () => {
      const first = await ctx.client.as(ctx.P.OWNER).get('/v1/runtime-assets/manifest');
      const second = await ctx.client.as(ctx.P.OWNER).get('/v1/runtime-assets/manifest');
      first.status(200);
      second.status(200);
      if (JSON.stringify(first.json()) !== JSON.stringify(second.json())) {
        throw new Error('the manifest must not change within one deploy — a sandbox polls it every start');
      }
    });
  },
);

flow(
  'RTA-2',
  {
    domain: 'runtime-assets',
    routes: [
      'GET /v1/runtime-assets/managed-skills',
      'GET /v1/runtime-assets/manifest',
      'POST /v1/projects/:projectId/cli-token',
    ],
  },
  async (ctx) => {
    const projectPat = await createProjectPat(ctx, 'runtime-assets-skills-pat');

    await ctx.step('ANON cannot download the managed-skill overlay', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/runtime-assets/managed-skills');
      r.status(401);
    });

    let hash = '';
    await ctx.step('authed download → 200 with the overlay files and the manifest hash', async () => {
      const manifest = await projectPat.get('/v1/runtime-assets/manifest');
      manifest.status(200);
      hash = manifest.json<{ managed_skills_hash: string }>().managed_skills_hash;

      const r = await projectPat.get('/v1/runtime-assets/managed-skills');
      r.status(200).body().exists('$.hash').exists('$.files');
      const body = r.json<{ hash: string; files: { path: string; content: string }[] }>();
      if (body.hash !== hash) {
        throw new Error(`payload hash ${body.hash} must equal the manifest hash ${hash}`);
      }
      // The edge (Cloudflare) may weaken a strong ETag to `W/"<hash>"` when it
      // compresses the response — a weak validator carrying the SAME content
      // hash. Strip an optional `W/` prefix before comparing; the hash is what
      // this asserts, not the validator strength.
      const etag = (r.header('etag') ?? '').replace(/^W\//, '');
      if (etag !== `"${hash}"`) {
        throw new Error(`ETag must be the content hash "${hash}", got ${r.header('etag')}`);
      }
      // The overlay is what teaches every agent the platform. If kortix-system
      // is missing, a sandbox that reconciles is worse off than one that did not.
      if (!body.files.some((f) => f.path === 'kortix-system/SKILL.md')) {
        throw new Error('the overlay must carry kortix-system/SKILL.md');
      }
      for (const f of body.files) {
        if (!f.path.startsWith('kortix-')) {
          throw new Error(`overlay path outside the managed family: ${f.path}`);
        }
        if (f.path.includes('..') || f.path.startsWith('/')) {
          throw new Error(`overlay path escapes the overlay root: ${f.path}`);
        }
      }
    });

    await ctx.step('If-None-Match with the current hash → 304, no body', async () => {
      const r = await projectPat.get('/v1/runtime-assets/managed-skills', {
        headers: { 'If-None-Match': `"${hash}"` },
      });
      r.status(304);
      if (r.text().length > 0) throw new Error('a 304 must carry no body');
    });

    await ctx.step('If-None-Match with a stale hash → 200, full payload', async () => {
      const r = await projectPat.get('/v1/runtime-assets/managed-skills', {
        headers: { 'If-None-Match': '"0000000000000000000000000000000000000000000000000000000000000000"' },
      });
      r.status(200).body().exists('$.files');
    });
  },
);

flow(
  'RTA-3',
  {
    domain: 'runtime-assets',
    routes: [
      'GET /v1/runtime-assets/cli',
      'HEAD /v1/runtime-assets/cli',
      'GET /v1/runtime-assets/manifest',
      'POST /v1/projects/:projectId/cli-token',
    ],
  },
  async (ctx) => {
    const projectPat = await createProjectPat(ctx, 'runtime-assets-cli-pat');

    await ctx.step('ANON cannot download the CLI binary', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/runtime-assets/cli');
      r.status(401);
    });

    await ctx.step('a converged sandbox transfers nothing — matching ETag → 304', async () => {
      const manifest = await projectPat.get('/v1/runtime-assets/manifest');
      manifest.status(200);
      const sha = manifest.json<{ cli_sha256: string | null }>().cli_sha256;
      if (sha === null) {
        // A local profile that never built apps/cli/dist/kortix. The contract in
        // that state is an honest 404, not a partial or fabricated body.
        const missing = await projectPat.get('/v1/runtime-assets/cli');
        missing.status(404);
        return;
      }
      // Never fetch the body: it is ~100 MB. The 304 proves the route, the auth,
      // and that the ETag is the manifest digest — which is the whole contract a
      // reconciling sandbox depends on.
      const r = await projectPat.get('/v1/runtime-assets/cli', {
        headers: { 'If-None-Match': `"${sha}"` },
      });
      r.status(304);
      if (r.text().length > 0) throw new Error('a 304 must carry no body');
    });

    await ctx.step('a stale ETag gets the binary, with a length and a digest header', async () => {
      const manifest = await projectPat.get('/v1/runtime-assets/manifest');
      manifest.status(200);
      const body = manifest.json<{ cli_sha256: string | null; cli_size: number | null }>();
      if (body.cli_sha256 === null) return;
      // HEAD, not GET: same headers, no 100 MB transfer.
      const r = await projectPat.request('HEAD', '/v1/runtime-assets/cli', {
        headers: { 'If-None-Match': '"0000000000000000000000000000000000000000000000000000000000000000"' },
      });
      r.status(200);
      if (r.header('content-length') !== String(body.cli_size)) {
        throw new Error(
          `Content-Length ${r.header('content-length')} must equal the manifest cli_size ${body.cli_size}`,
        );
      }
      if (r.header('x-kortix-cli-sha256') !== body.cli_sha256) {
        throw new Error('the response must name the digest the caller is expected to verify');
      }
    });
  },
);

// ── RTA-4 — entrypoint: served, never converged ─────────────────────────────
//
// The manifest advertised `components.entrypoint` and NO box has ever consumed
// it: `git grep -n entrypoint -- apps/kortix-sandbox-agent-server/src/services/runtime-assets/runtime-assets.ts
// apps/kortix-sandbox-agent-server/src/harness` returns doc comments only. An
// advertised-but-unconsumed component reads as a fifth convergeable asset, which
// is how a "current" box can be quietly wrong. This pins the decision that was
// made instead: it is out-of-band repair only, it keeps the same
// content-addressed shape as the CLI and the agent, and `runningAssetsVerdict`
// leaves it out of the comparison so it can never make a box read as behind.
flow(
  'RTA-4',
  {
    domain: 'runtime-assets',
    routes: [
      'GET /v1/runtime-assets/entrypoint',
      'HEAD /v1/runtime-assets/entrypoint',
      'GET /v1/runtime-assets/manifest',
      'POST /v1/projects/:projectId/cli-token',
    ],
  },
  async (ctx) => {
    const projectPat = await createProjectPat(ctx, 'runtime-assets-entrypoint-pat');

    await ctx.step('ANON cannot download the supervisor script', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/runtime-assets/entrypoint');
      r.status(401);
    });

    await ctx.step('the manifest digest is the ETag, and a matching one transfers nothing', async () => {
      const manifest = await projectPat.get('/v1/runtime-assets/manifest');
      manifest.status(200);
      const entrypoint = manifest.json<{
        components?: { entrypoint?: { sha256?: string; size?: number } };
      }>().components?.entrypoint;
      if (!entrypoint?.sha256) {
        // No script in this image. The contract in that state is an honest 404,
        // not a partial or fabricated body — same rule as the CLI half.
        const missing = await projectPat.get('/v1/runtime-assets/entrypoint');
        missing.status(404);
        return;
      }
      if (!SHA256.test(entrypoint.sha256)) {
        throw new Error(`components.entrypoint.sha256 must be a sha256, got ${entrypoint.sha256}`);
      }
      const fresh = await projectPat.get('/v1/runtime-assets/entrypoint', {
        headers: { 'If-None-Match': `"${entrypoint.sha256}"` },
      });
      fresh.status(304);
      if (fresh.text().length > 0) throw new Error('a 304 must carry no body');

      const head = await projectPat.request('HEAD', '/v1/runtime-assets/entrypoint');
      head.status(200);
      if (head.header('x-kortix-entrypoint-sha256') !== entrypoint.sha256) {
        throw new Error('the route must name the digest the manifest promises');
      }
      if (head.header('content-length') !== String(entrypoint.size)) {
        throw new Error(
          `Content-Length ${head.header('content-length')} must equal components.entrypoint.size ${entrypoint.size}`,
        );
      }
    });

    await ctx.step('the body is the supervisor script itself, not a stub', async () => {
      const manifest = await projectPat.get('/v1/runtime-assets/manifest');
      manifest.status(200);
      if (!manifest.json<{ components?: { entrypoint?: unknown } }>().components?.entrypoint) return;
      // Small enough to fetch, unlike the ~100 MB binaries: it is a shell script.
      const r = await projectPat.get('/v1/runtime-assets/entrypoint');
      r.status(200);
      const body = r.text();
      if (!body.startsWith('#!')) {
        throw new Error('the entrypoint must be served as the executable script it is');
      }
      // The two names that make it the SUPERVISOR rather than any shell script.
      // If a refactor moves the staged-swap out of here, the component this route
      // serves is no longer the thing a repair job needs.
      for (const marker of ['agent.next', 'agent.pinned']) {
        if (!body.includes(marker)) {
          throw new Error(`the served entrypoint does not look like the supervisor: no ${marker}`);
        }
      }
    });
  },
);

// ── RTA-5 / RTA-6 — "latest at prompt send", on a real box ──────────────────
//
// THE ASYMMETRY THESE PROVE. Config BLOCKS the turn, because config changes what
// the agent IS; a stale box pays a measured 10,287-10,907 ms. Binaries MUST NOT
// block: the daemon, the CLI, the overlay and OpenCode are ~96 MB, ~104 MB,
// ~373 KB and ~167 MB, and a box that makes the user wait for those is a
// regression on a box that is merely one turn behind. So the lane DETECTS and
// SCHEDULES, and these flows' job is to show that detection is free.
//
// WHY TWO FLOWS, and not one. The digest half needs a real box and NO model
// spend; the latency half needs real turns, so it needs `funded`, which no
// automated lane sets (`tests/src/core/env.ts` — `KE2E_CAP_FUNDED` is '1'
// nowhere in CI, and the local profile pins it to '0'). One combined flow
// therefore ran NOWHERE. Split, RTA-5 runs on every preview against a real
// Platinum box and RTA-6 stays the operator-run half.
//
// NEITHER RUNS AGAINST A LOCAL STACK, and not because of the capability flag: a
// local-target project is a database project whose `repo_url` is unreachable
// from a cloud box, so the box boots to
// `runtimeBootPhase=…|repo_materialization_failed` and is stopped with
// `stopReason=runtime_boot_failed` (observed 2026-09-26). That is what
// `EXTERNAL_CAPABILITIES` excludes from the local profile, and it is why these
// are deployed-target flows.
//
// WHAT CANNOT BE STAGED HERE, said plainly rather than faked: the BEHIND half
// needs the deploy's binaries to differ from the box's image, which no test can
// arrange. The swap decision table, the pre-exec probe and the OpenCode rollback
// are proved in apps/kortix-sandbox-agent-server/src/__tests__/runtime-convergence.test.ts,
// and the comparison and the memo in
// apps/api/src/runtime-assets/__tests__/running-assets.test.ts.
//
// TEST DEFECT, fixed here: on a deployed target, `env.target !== 'local'` takes
// `ctx.fixtures.project()` with no `seed`/`managedGit` down the SAME
// database-only branch (`tests/src/fixtures/world.ts` `createProject`,
// `canCreateDatabaseProject && (... || (!opts?.seed && !opts?.managedGit))`),
// so its `repo_url` was unreachable from the real box exactly like the local
// case above — every gate run hit `repo_materialization_failed` and burned the
// full 600s wait. `bootBox` now takes a `{ seed: true }` project (real managed
// Git repo, starter seeded), the same fixture `SESS-30` uses for the same
// reason. The start-wait is also wrapped with
// `markSessionReadinessTimeoutRetryable`, so a genuine transient boot timeout
// gets the session-runtime retry class instead of failing the gate outright.

/** What a box says it is RUNNING — the health `runtime.running` block. */
interface RunningAssets {
  cli_sha256: string | null;
  managed_skills_hash: string | null;
  agent_sha256: string | null;
  staged_agent_sha256: string | null;
  /** The harness `harness_version` belongs to (W3 E17). */
  harness: string | null;
  harness_version: string | null;
}

/**
 * The WHICH-BYTES identity a "reading must not change it" check may compare.
 * The raw `runtime.running` payload also carries `build`/`at` (the daemon's
 * last reconciliation PASS) and other operational fields (managed model ids,
 * catalog fallback reason, agent path) that legitimately advance between two
 * health reads a few seconds apart — this file's own comment on `bootBox`
 * says so: "`build`/`at` describe the last PASS and may legitimately be null
 * on a box whose daemon restarted; `running` may not." Comparing the full raw
 * object caught that legitimate advance as a false "the lane applied
 * something" (gate run 36497729410: `build` went `null` → `1790636576`
 * between two reads 8s apart on a real Platinum box; every earlier gate ran
 * against a stub that always reported `null`, so this never fired). Compare
 * only the typed identity fields.
 */
function identityOf(running: RunningAssets): RunningAssets {
  const { cli_sha256, managed_skills_hash, agent_sha256, staged_agent_sha256, harness, harness_version } = running;
  return { cli_sha256, managed_skills_hash, agent_sha256, staged_agent_sha256, harness, harness_version };
}

interface BootedBox {
  sandboxId: string;
  box: (suffix: string) => string;
  runtimeBlock: () => Promise<{
    running?: RunningAssets;
    pinned?: boolean;
    agentSwapPending?: boolean;
  }>;
}

/** Boot a session to `ready` and return its box's addresses. */
async function bootBox(ctx: FlowContext, project: CreatedProject): Promise<BootedBox> {
  const session = await ctx.fixtures.session(project);
  let started: any;
  try {
    started = await waitFor(
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post('/v1/projects/:projectId/sessions/:sessionId/start', {}, {
            params: { projectId: project.id, sessionId: session.id },
            query: { wait_ms: '8000' },
            timeoutMs: 25_000,
          });
        if (r.statusCode >= 500) return null;
        r.status(200);
        return r.json<any>();
      },
      {
        until: (s) => s?.stage === 'ready' && Boolean(s?.sandbox?.external_id ?? s?.sandbox?.externalId),
        timeoutMs: 600_000,
        intervalMs: 3_000,
        description: `session runtime ready for ${session.id}`,
        retryOnError: isKe2eRetryableError,
      },
    );
  } catch (error) {
    throw markSessionReadinessTimeoutRetryable(error, session.id);
  }
  const sandboxId = String(started.sandbox.external_id ?? started.sandbox.externalId);
  const box = (suffix: string) => `/v1/p/${sandboxId}/8000${suffix}`;
  return {
    sandboxId,
    box,
    runtimeBlock: async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(box('/kortix/health'));
      r.status(200);
      const runtime = r.json<{
        runtime?: { running?: RunningAssets; pinned?: boolean; agentSwapPending?: boolean };
      }>().runtime;
      if (!runtime) throw new Error('the health report carries no `runtime` block');
      return runtime;
    },
  };
}

/** Every component both sides state must agree, sha-to-sha where a sha exists. */
async function assertBoxIsCurrent(ctx: FlowContext, running: RunningAssets): Promise<void> {
  const manifest = await ctx.client.as(ctx.P.OWNER).get('/v1/runtime-assets/manifest');
  manifest.status(200);
  const m = manifest.json<{
    components: {
      cli?: { sha256?: string };
      agent?: { sha256?: string };
      opencode: { version: string };
      'managed-skills': { hash: string };
    };
  }>();
  // sha-to-sha wherever a sha exists: a version string cannot prove which bytes
  // are on disk. OpenCode is the one exception and it is forced — the manifest
  // carries only a version for it, because the bytes come from npm.
  const pairs: Array<[string, string | undefined, string | null]> = [
    ['managed-skills', m.components['managed-skills'].hash, running.managed_skills_hash],
    ['cli', m.components.cli?.sha256, running.cli_sha256],
    ['agent', m.components.agent?.sha256, running.agent_sha256],
    // The manifest's OpenCode release applies to an OpenCode box only.
    ['opencode', m.components.opencode.version, running.harness === 'opencode' ? running.harness_version : null],
  ];
  for (const [name, want, have] of pairs) {
    if (!want || !have) continue; // this deploy or this box states nothing to compare
    if (want !== have) {
      throw new Error(`a freshly booted box is behind on ${name}: deploy ${want}, box ${have}`);
    }
  }
}

flow(
  'RTA-5',
  {
    domain: 'runtime-assets',
    // NOT `funded`. Nothing here runs a model turn, so this half is the one that
    // can run in every preview — which is the only place a real box exists.
    requires: ['database', 'daytona'],
    timeoutMs: 900_000,
    routes: ['GET /v1/runtime-assets/manifest', 'POST /v1/projects/:projectId/sessions/:sessionId/start'],
  },
  async (ctx) => {
    // `seed: true`: a database-only project's `repo_url` cannot be cloned by a
    // real box (it boots to `repo_materialization_failed` and never reaches
    // `ready` — see the note above), so `bootBox` needs a real, clonable repo.
    const project = await ctx.fixtures.project({ seed: true });
    let booted: BootedBox;
    let running: RunningAssets;

    await ctx.step('a session boots on a real box', async () => {
      booted = await bootBox(ctx, project);
    });

    await ctx.step('the box states WHICH BYTES it is running, not just what its last pass did', async () => {
      const runtime = await booted.runtimeBlock();
      if (!runtime.running) {
        throw new Error('`runtime.running` is missing — the API cannot tell a current box from a behind one');
      }
      running = runtime.running;
      // Read from /opt/kortix/runtime-assets-state.json, so it survives a daemon
      // restart. `build`/`at` describe the last PASS and may legitimately be
      // null on a box whose daemon restarted; `running` may not.
      if (!running.managed_skills_hash) {
        throw new Error('a booted box must state the managed-skill overlay it has on disk');
      }
      if (runtime.pinned !== false) {
        throw new Error('a healthy box must not report a rollback latch');
      }
      if (runtime.agentSwapPending !== false) {
        throw new Error('a box with nothing staged must not claim a pending swap');
      }
    });

    await ctx.step('a freshly booted box IS current — every digest equals the deploy`s', async () => {
      await assertBoxIsCurrent(ctx, running);
    });

    await ctx.step('and the lane APPLIED nothing while it was being read', async () => {
      const after = (await booted.runtimeBlock()).running;
      if (!after) throw new Error('`runtime.running` is missing on the second read');
      const before = identityOf(running);
      const afterIdentity = identityOf(after);
      if (JSON.stringify(afterIdentity) !== JSON.stringify(before)) {
        throw new Error(
          `reading a current box must not change it: ${JSON.stringify(before)} → ${JSON.stringify(afterIdentity)}`,
        );
      }
    });
  },
);

flow(
  'RTA-6',
  {
    domain: 'runtime-assets',
    // `funded`: every step below runs a real model turn. Operator-run.
    requires: ['database', 'funded', 'daytona'],
    timeoutMs: 1_200_000,
    routes: ['GET /v1/runtime-assets/manifest', 'POST /v1/projects/:projectId/sessions/:sessionId/start'],
  },
  async (ctx) => {
    // `seed: true`: same reason as RTA-5 — `bootBox` needs a real, clonable repo.
    const project = await ctx.fixtures.project({ seed: true });
    let booted: BootedBox;
    let conversationId = '';
    let before: RunningAssets;

    await ctx.step('a session boots and opens an OpenCode conversation', async () => {
      booted = await bootBox(ctx, project);
      const created = await waitFor(
        async () => {
          const r = await ctx.client
            .as(ctx.P.OWNER)
            .post(booted.box(`/session?directory=${encodeURIComponent('/workspace')}`), {});
          return r.statusCode >= 500 ? null : r;
        },
        { until: (r) => Boolean(r), timeoutMs: 180_000, intervalMs: 3_000, description: 'opencode conversation' },
      );
      created!.status(200);
      conversationId = String(created!.json<{ id: string }>().id);
      const runtime = await booted.runtimeBlock();
      if (!runtime.running) throw new Error('the health report carries no `runtime.running` block');
      before = runtime.running;
      await assertBoxIsCurrent(ctx, before);
    });

    await ctx.step('the lane costs the send nothing: a second prompt is no slower', async () => {
      const send = async (text: string) => {
        const at = Date.now();
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(booted.box(`/session/${conversationId}/message`), { parts: [{ type: 'text', text }] }, {
            timeoutMs: 180_000,
          });
        r.status(200);
        const body = r.json<any>();
        if (body?.deduplicated) throw new Error('the prompt was swallowed as a duplicate');
        if (!body?.info || !Array.isArray(body?.parts)) {
          throw new Error(`the send did not answer with a message: ${JSON.stringify(body).slice(0, 200)}`);
        }
        return Date.now() - at;
      };
      const first = await send('reply with the single word one');
      const second = await send('reply with the single word two');
      // Deliberately a band, not a threshold: a turn's duration is the model's,
      // not the gate's. What is being ruled out is the lane ever APPLYING
      // anything on the send path — an install is 30-120 s and a daemon swap 6-9
      // s of unreachable box, neither of which hides inside this margin.
      if (second > first * 2 + 10_000) {
        throw new Error(
          `the second send took ${second} ms against a first of ${first} ms — the asset lane is on the latency path`,
        );
      }
    });

    // THE SECRETS-GATE PARITY HALF, on a real box.
    //
    // `/p/<ext>/4096/...` is the same turn as `/p/<ext>/8000/...`: Platinum
    // rewrites 4096 → 8000 upstream and Daytona passes it through. Before this
    // lane the two call sites in `sandbox-proxy/routes/preview.ts` read
    // DIFFERENT port variables for that one request, so the prompt got the
    // config convergence and the undeclared-agent drop but no secret refresh and
    // no connector-grant re-mint. Both sites now read `upstreamPort` through one
    // predicate.
    //
    // WHAT THIS STEP CAN AND CANNOT SEE. The env sync and the re-mint are
    // server-side and leave no field on this response, so what is asserted here
    // is that the widened predicate carries a real turn on the OpenCode port
    // rather than refusing or wedging it. Which collaborators run for which
    // (port, path) is proved exactly, with both providers' routing shapes, in
    // apps/api/src/sandbox-proxy/routes/preview-env-sync-ports.test.ts.
    await ctx.step('a prompt addressed straight at the OpenCode port runs a real turn', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          `/v1/p/${booted.sandboxId}/4096/session/${conversationId}/message`,
          { parts: [{ type: 'text', text: 'reply with the single word three' }] },
          { timeoutMs: 180_000 },
        );
      r.status(200);
      const body = r.json<any>();
      if (body?.deduplicated) throw new Error('the prompt was swallowed as a duplicate');
      if (!body?.info || !Array.isArray(body?.parts)) {
        throw new Error(`the :4096 send did not answer with a message: ${JSON.stringify(body).slice(0, 200)}`);
      }
    });

    await ctx.step('and it APPLIED nothing: the box runs the same bytes it started with', async () => {
      const after = (await booted.runtimeBlock()).running;
      if (!after) throw new Error('`runtime.running` is missing on the second read');
      const beforeIdentity = identityOf(before);
      const afterIdentity = identityOf(after);
      if (JSON.stringify(afterIdentity) !== JSON.stringify(beforeIdentity)) {
        throw new Error(
          `a current box must not be changed by sending prompts: ${JSON.stringify(beforeIdentity)} → ${JSON.stringify(afterIdentity)}`,
        );
      }
    });
  },
);

// ── RTA-7 — content-addressed chunks ───────────────────────────────────────
//
// A changed CLI used to cost every box a fresh ~105 MB, of which ~90 MB
// provably did not change: that prefix is the embedded Bun runtime, identical
// in every `bun --compile` output. Measured at 1 MiB fixed chunks on real
// linux-x64 builds — 100 of 102 chunks shared between two CLI builds that
// differ only in their version stamp (98.0%), and 89 of 102 between the CLI
// and the daemon (87.3%) — the latter only when one Bun compiled both, which
// the shipped API image does not do today (two pins, 0 of 111 shared measured
// on a deployed preview). That is why the sharing step below is a soft check.
//
// These two routes are a TRANSFER optimization and nothing else, which is the
// property this flow exists to pin. The whole-file digest on `RTA-1` stays the
// authority; a box assembles, verifies against it, and falls back to the full
// `RTA-3` download on any doubt. So the contract here is narrow: name the same
// bytes the digest manifest names, serve a chunk under its own digest, and
// answer 404 rather than guess.
flow(
  'RTA-7',
  {
    domain: 'runtime-assets',
    routes: [
      'GET /v1/runtime-assets/chunk/:sha256',
      'GET /v1/runtime-assets/chunks/:component',
      'GET /v1/runtime-assets/manifest',
      'POST /v1/projects/:projectId/cli-token',
    ],
  },
  async (ctx) => {
    const projectPat = await createProjectPat(ctx, 'runtime-assets-chunks-pat');

    await ctx.step('ANON cannot read a chunk manifest or a chunk', async () => {
      (await ctx.client.as(ctx.P.ANON).get('/v1/runtime-assets/chunks/cli')).status(401);
      (
        await ctx.client
          .as(ctx.P.ANON)
          .get('/v1/runtime-assets/chunk/0000000000000000000000000000000000000000000000000000000000000000')
      ).status(401);
    });

    await ctx.step('the chunk manifest names the same bytes the digest manifest does', async () => {
      const manifest = await projectPat.get('/v1/runtime-assets/manifest');
      manifest.status(200);
      const digests = manifest.json<{ cli_sha256: string | null; cli_size: number | null }>();
      const chunks = await projectPat.get('/v1/runtime-assets/chunks/cli');
      if (digests.cli_sha256 === null) {
        // A checkout that never built apps/cli/dist/kortix. The honest answer
        // is a 404, exactly as `RTA-3` gives for the binary itself.
        chunks.status(404);
        return;
      }
      chunks.status(200);
      const body = chunks.json<{ sha256: string; size: number; chunk_size: number; chunks: string[] }>();
      if (body.sha256 !== digests.cli_sha256) {
        throw new Error(
          `the chunk manifest describes other bytes than the digest manifest: ${body.sha256} vs ${digests.cli_sha256}`,
        );
      }
      if (body.size !== digests.cli_size) {
        throw new Error(`chunk manifest size ${body.size} must equal cli_size ${digests.cli_size}`);
      }
      // Offsets are implied, so the count IS the layout. A manifest whose
      // arithmetic does not hold would have a box allocate the wrong buffer.
      const expected = Math.ceil(body.size / body.chunk_size);
      if (body.chunks.length !== expected) {
        throw new Error(`${body.chunks.length} chunks for ${body.size} bytes; expected ${expected}`);
      }
      if (!body.chunks.every((c) => /^[0-9a-f]{64}$/.test(c))) {
        throw new Error('every chunk must be named by a sha256');
      }
    });

    await ctx.step('a chunk is served under its own digest, at its own length', async () => {
      const chunks = await projectPat.get('/v1/runtime-assets/chunks/cli');
      if (chunks.statusCode === 404) return;
      chunks.status(200);
      const body = chunks.json<{ size: number; chunk_size: number; chunks: string[] }>();
      const digest = body.chunks[0]!;
      const r = await projectPat.get(`/v1/runtime-assets/chunk/${digest}`);
      r.status(200);
      // The name IS the content, so the ETag is the path.
      if (r.header('etag') !== `"${digest}"`) {
        throw new Error(`ETag ${r.header('etag')} must be the requested digest`);
      }
      const length = Math.min(body.chunk_size, body.size);
      if (r.header('content-length') !== String(length)) {
        throw new Error(`Content-Length ${r.header('content-length')} must be ${length}`);
      }
    });

    // ONE INDEX, BOTH BINARIES — asserted as the CONTRACT, not as an overlap.
    //
    // An earlier version of this step required the two to share a chunk, on the
    // reasoning that ~90 MB of each is the same embedded Bun runtime. That is
    // true of two binaries compiled by the SAME Bun and false of what we ship:
    // `apps/api/Dockerfile` builds the daemon on `SANDBOX_AGENT_BUN_VERSION`
    // (1.3.11, a deliberate pin) and the CLI on `BUN_VERSION` (1.2), so they
    // embed different runtimes. Measured on a deployed preview: 0 of 111 chunks
    // shared, first MiB already different. Requiring overlap would have pinned a
    // build coincidence rather than a contract — and would go red on a green
    // deploy. What the route actually promises is that ONE index answers for
    // BOTH components, which is what this asserts.
    await ctx.step('ONE index answers for both binaries', async () => {
      const cli = await projectPat.get('/v1/runtime-assets/chunks/cli');
      const agent = await projectPat.get('/v1/runtime-assets/chunks/agent');
      if (cli.statusCode === 404 || agent.statusCode === 404) return;
      for (const [name, res] of [['cli', cli], ['agent', agent]] as const) {
        const first = res.json<{ chunks: string[] }>().chunks[0]!;
        const r = await projectPat.get(`/v1/runtime-assets/chunk/${first}`);
        if (r.statusCode !== 200) {
          throw new Error(`the ${name} chunk index and the chunk route disagree: ${r.statusCode}`);
        }
        // The caller never says which component it wants; the digest is enough.
        if (r.header('etag') !== `"${first}"`) {
          throw new Error(`ETag ${r.header('etag')} must be the requested digest`);
        }
      }
    });

    await ctx.step('a chunk this deploy does not carry is a 404, never a guess', async () => {
      const r = await projectPat.get(
        '/v1/runtime-assets/chunk/1111111111111111111111111111111111111111111111111111111111111111',
      );
      r.status(404);
    });
  },
);
