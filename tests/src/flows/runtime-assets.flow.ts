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
    routes: ['GET /v1/runtime-assets/manifest', 'POST /v1/projects/:projectId/cli-token'],
  },
  async (ctx) => {
    const projectPat = await createProjectPat(ctx, 'runtime-assets-manifest-pat');

    await ctx.step('ANON cannot read the runtime-asset manifest', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/runtime-assets/manifest');
      r.status(401);
    });

    await ctx.step('a PROJECT-scoped PAT can read it — this is the in-sandbox daemon', async () => {
      // The KORTIX_CLI_TOKEN injected into every sandbox is a project+session
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
      if (r.header('etag') !== `"${hash}"`) {
        throw new Error(`ETag must be the content hash, got ${r.header('etag')}`);
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
