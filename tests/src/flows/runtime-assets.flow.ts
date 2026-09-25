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
import { waitFor } from '../core/poll';
import type { FlowContext } from '../core/types';

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
// it: `git grep -n entrypoint -- apps/kortix-sandbox-agent-server/src/runtime-assets.ts
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

// ── RTA-5 — "latest at prompt send", on a real box ──────────────────────────
//
// THE ASYMMETRY THIS PROVES. Config BLOCKS the turn, because config changes what
// the agent IS; a stale box pays a measured 10,287-10,907 ms. Binaries MUST NOT
// block: the daemon, the CLI, the overlay and OpenCode are ~96 MB, ~104 MB,
// ~373 KB and ~167 MB, and a box that makes the user wait for those is a
// regression on a box that is merely one turn behind. So the lane DETECTS and
// SCHEDULES, and this flow's job is to show that detection is free.
//
// WHAT CANNOT BE STAGED HERE, said plainly rather than faked: the BEHIND half
// needs the deploy's binaries to differ from the box's image, which no test can
// arrange. The swap decision table, the pre-exec probe and the OpenCode rollback
// are proved in apps/kortix-sandbox-agent-server/src/__tests__/runtime-convergence.test.ts,
// and the comparison and the memo in
// apps/api/src/runtime-assets/__tests__/running-assets.test.ts.
flow(
  'RTA-5',
  {
    domain: 'runtime-assets',
    requires: ['database', 'funded', 'daytona'],
    timeoutMs: 1_200_000,
    routes: ['GET /v1/runtime-assets/manifest', 'POST /v1/projects/:projectId/sessions/:sessionId/start'],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    let sandboxId = '';
    let conversationId = '';
    const box = (suffix: string) => `/v1/p/${sandboxId}/8000${suffix}`;

    await ctx.step('a session boots and opens an OpenCode conversation', async () => {
      const session = await ctx.fixtures.session(project, { prompt: 'say hello' });
      const started = await waitFor(
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
        },
      );
      sandboxId = String(started.sandbox.external_id ?? started.sandbox.externalId);
      const created = await waitFor(
        async () => {
          const r = await ctx.client
            .as(ctx.P.OWNER)
            .post(box(`/session?directory=${encodeURIComponent('/workspace')}`), {});
          return r.statusCode >= 500 ? null : r;
        },
        { until: (r) => Boolean(r), timeoutMs: 180_000, intervalMs: 3_000, description: 'opencode conversation' },
      );
      created!.status(200);
      conversationId = String(created!.json<{ id: string }>().id);
    });

    type Running = {
      cli_sha256: string | null;
      managed_skills_hash: string | null;
      agent_sha256: string | null;
      staged_agent_sha256: string | null;
      opencode_version: string | null;
    };
    const runtimeBlock = async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(box('/kortix/health'));
      r.status(200);
      const runtime = r.json<{
        runtime?: { running?: Running; pinned?: boolean; agentSwapPending?: boolean };
      }>().runtime;
      if (!runtime) throw new Error('the health report carries no `runtime` block');
      return runtime;
    };

    let before: Running;
    await ctx.step('the box states WHICH BYTES it is running, not just what its last pass did', async () => {
      const runtime = await runtimeBlock();
      if (!runtime.running) {
        throw new Error('`runtime.running` is missing — the API cannot tell a current box from a behind one');
      }
      before = runtime.running;
      // Read from /opt/kortix/runtime-assets-state.json, so it survives a daemon
      // restart. `build`/`at` describe the last PASS and may legitimately be
      // null on a box whose daemon restarted; `running` may not.
      if (!before.managed_skills_hash) {
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
      // sha-to-sha wherever a sha exists: a version string cannot prove which
      // bytes are on disk. OpenCode is the one exception and it is forced — the
      // manifest carries only a version for it, because the bytes come from npm.
      const pairs: Array<[string, string | undefined, string | null]> = [
        ['managed-skills', m.components['managed-skills'].hash, before.managed_skills_hash],
        ['cli', m.components.cli?.sha256, before.cli_sha256],
        ['agent', m.components.agent?.sha256, before.agent_sha256],
        ['opencode', m.components.opencode.version, before.opencode_version],
      ];
      for (const [name, want, have] of pairs) {
        if (!want || !have) continue; // this deploy or this box states nothing to compare
        if (want !== have) {
          throw new Error(`a freshly booted box is behind on ${name}: deploy ${want}, box ${have}`);
        }
      }
    });

    await ctx.step('the lane costs the send nothing: a second prompt is no slower', async () => {
      const send = async (text: string) => {
        const at = Date.now();
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(box(`/session/${conversationId}/message`), { parts: [{ type: 'text', text }] }, {
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

    await ctx.step('and it APPLIED nothing: the box runs the same bytes it started with', async () => {
      const after = (await runtimeBlock()).running;
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(
          `a current box must not be changed by sending prompts: ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
        );
      }
    });
  },
);
