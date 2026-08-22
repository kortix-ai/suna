/**
 * /v1/runtime-assets — the deployed API serves the runtime assets its own
 * sandboxes must be running.
 *
 * THE PROBLEM THIS EXISTS FOR. A sandbox's `kortix` CLI and its managed-skill
 * overlay are baked into an image at snapshot-build time and then never touched
 * again. Restart and resume suspend/resume the SAME VM, and warm-fork adoption
 * reuses a captured disk, so a box provisioned months ago keeps its months-old
 * binary forever. When commit e868be1d6c renamed `/executor/*` to `/connectors/*`,
 * every one of those sandboxes started 404ing on `kortix connectors …` and had
 * no mechanism to notice, let alone fix itself.
 *
 * WHY THE API AND NOT A RELEASE ARTIFACT. The sandbox already talks to exactly
 * one API, over a link it already has credentials for. Making that API the
 * source of truth gives CLI↔API consistency by construction — a sandbox
 * converges on the binary that the very deploy serving it was built with — and
 * works on dev and staging, which run ahead of any published release.
 *
 * AUTH — `combinedAuth`, mounted in index.ts, exactly like /v1/skills and for
 * exactly the same reason: the callers that matter are a CLI holding a
 * `kortix_pat_` and an in-sandbox daemon holding the platform-injected
 * `KORTIX_CLI_TOKEN` session PAT. Content is identical for every caller — this
 * is authentication, not authorization. The CLI binary is not a secret (it is
 * published on every release), but it is not an anonymous 100 MB download
 * either.
 *
 * SHAPE — a cheap manifest plus three payload routes, because the payloads are
 * large and almost always unnecessary:
 *   GET /manifest        ~700 B — digests only. Polled on every session start.
 *   GET /cli             ~104 MB — the `kortix` binary. Only on a digest mismatch.
 *   GET /agent           ~96 MB — the `kortix-agent` daemon. Same.
 *   GET /managed-skills  ~300 KB — the overlay files. Same.
 * `opencode` is deliberately NOT proxied here: the manifest states the expected
 * version and the daemon fetches it from npm, because 167 MB per stale box has
 * no business crossing our own control plane.
 * Every payload route is content-addressed (`ETag` = the digest from the
 * manifest) and honours `If-None-Match` with a 304, so a caller that re-fetches
 * without checking the manifest first still pays nothing.
 *
 * The managed-skill payload is JSON, not a tarball, on purpose: the sandbox
 * daemon depends on hono + zod and nothing else, so an archive format would
 * force either a new dependency or a `tar` subprocess into the one code path
 * that must never fail loudly. Every managed skill is UTF-8 markdown.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { etagMatches } from '../shared/http-cache';
import type { AppEnv } from '../types';
import {
  managedSkillOverlay,
  runtimeAgentBinaryPath,
  runtimeAssetsManifest,
  runtimeCliBinaryPath,
} from './manifest';

// Re-exported so server startup can warm the digest memo off the request path
// (see the call in src/index.ts). Hashing ~200 MB of binaries inside the 25s
// request deadline made the first post-deploy caller 503, and that caller is a
// booting sandbox.
export { runtimeAssetsManifest } from './manifest';

export const runtimeAssetsApp = makeOpenApiApp<AppEnv>();

const BinaryComponentSchema = z.object({
  version: z.string().nullable(),
  sha256: z.string(),
  size: z.number().int(),
  path: z.string(),
});

const ManifestSchema = z
  .object({
    // v1 — load-bearing for daemons already in the field. Never remove one.
    cli_version: z.string().nullable(),
    cli_sha256: z.string().nullable(),
    cli_size: z.number().int().nullable(),
    managed_skills_hash: z.string(),
    managed_skills_count: z.number().int(),
    // v2 — additive.
    build: z.number().int(),
    components: z.object({
      agent: BinaryComponentSchema.optional(),
      cli: BinaryComponentSchema.optional(),
      opencode: z.object({ version: z.string(), source: z.literal('npm') }),
      'managed-skills': z.object({ hash: z.string(), count: z.number().int() }),
    }),
    policy: z.object({ agent_self_update: z.boolean() }),
  })
  .openapi('RuntimeAssetsManifest');

const ManagedSkillsSchema = z
  .object({
    hash: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
  })
  .openapi('RuntimeAssetsManagedSkills');

runtimeAssetsApp.openapi(
  createRoute({
    method: 'get',
    path: '/manifest',
    tags: ['runtime-assets'],
    summary: 'GET /runtime-assets/manifest — digests of this deploy\'s sandbox runtime assets',
    description:
      'Identifies the `kortix-agent` daemon, `kortix` CLI binary, expected `opencode` version, ' +
      'and managed-skill overlay this API was built with. A sandbox compares these digests ' +
      'against what it has on disk and downloads only on a mismatch. The top-level `cli_*` and ' +
      '`managed_skills_*` keys are the permanent v1 contract for daemons already in the field; ' +
      '`build`, `components`, and `policy` are the additive v2 surface. `build` is monotonic per ' +
      'deploy — a box refuses a manifest whose `build` is lower than the one it converged to, ' +
      'so two concurrently-live API versions during a rolling deploy cannot make it oscillate. ' +
      'A component is absent from `components` when this image carries no such binary.',
    ...auth,
    responses: {
      200: json(ManifestSchema, 'Runtime asset digests'),
      ...errors(401),
    },
  }),
  async (c) => {
    const manifest = await runtimeAssetsManifest();
    // Short max-age + ETag: the payload is immutable for a deploy, but a caller
    // must see a new deploy's digests promptly rather than after a cache TTL.
    c.header('Cache-Control', 'no-cache');
    return c.json(manifest);
  },
);

type BinaryContext = {
  req: { header: (name: string) => string | undefined; method: string };
  header: (name: string, value: string) => void;
  json: (body: unknown, status: 404) => Response;
  body: (body: ReadableStream | null, status: 200 | 304) => Response;
};

/**
 * Shared by GET and HEAD, and by both binary components. HEAD is registered
 * explicitly below because nothing in the stack synthesizes it, and it is the
 * only way to read `Content-Length` without transferring ~100 MB — which is what
 * both a size check and the ke2e flow need.
 *
 * One implementation for `/cli` and `/agent` on purpose: they are the same
 * contract (content-addressed ETag, conditional 304, streamed body, 404 when the
 * image carries no such binary) and two copies would drift.
 */
async function serveBinary(
  c: BinaryContext,
  component: 'agent' | 'cli',
  absentMessage: string,
  headerPrefix: string,
  binaryPath: () => string,
): Promise<Response> {
  const manifest = await runtimeAssetsManifest();
  const asset = manifest.components[component];
  if (!asset) {
    return c.json({ error: true, message: absentMessage, status: 404 }, 404);
  }
  const etag = `"${asset.sha256}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'no-cache');
  if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Length', String(asset.size));
  c.header(`${headerPrefix}-Sha256`, asset.sha256);
  if (asset.version) c.header(`${headerPrefix}-Version`, asset.version);
  if (c.req.method === 'HEAD') return c.body(null, 200);
  // Streamed, not read into memory: this is ~100 MB and several sandboxes can
  // converge at once after a deploy.
  return c.body(Bun.file(binaryPath()).stream(), 200);
}

const serveCli = (c: BinaryContext) =>
  serveBinary(
    c,
    'cli',
    'This deploy carries no sandbox CLI binary',
    'X-Kortix-Cli',
    runtimeCliBinaryPath,
  );

const serveAgent = (c: BinaryContext) =>
  serveBinary(
    c,
    'agent',
    'This deploy carries no sandbox agent binary',
    'X-Kortix-Agent',
    runtimeAgentBinaryPath,
  );

runtimeAssetsApp.on('HEAD', '/cli', (c) => serveCli(c as never));
runtimeAssetsApp.on('HEAD', '/agent', (c) => serveAgent(c as never));

runtimeAssetsApp.openapi(
  createRoute({
    method: 'get',
    path: '/cli',
    tags: ['runtime-assets'],
    summary: 'GET /runtime-assets/cli — the `kortix` binary this deploy bakes into sandboxes',
    description:
      'Streams the Linux binary from the API image. `ETag` is its sha256 (the manifest\'s ' +
      '`cli_sha256`); send `If-None-Match` to get a 304 instead of the body. 404 when the ' +
      'image carries no CLI binary.',
    ...auth,
    responses: {
      200: {
        description: 'The compiled kortix CLI',
        content: { 'application/octet-stream': { schema: z.string() } },
      },
      304: { description: 'Not modified' },
      ...errors(401, 404),
    },
  }),
  (c) => serveCli(c as never) as never,
);

runtimeAssetsApp.openapi(
  createRoute({
    method: 'get',
    path: '/agent',
    tags: ['runtime-assets'],
    summary: 'GET /runtime-assets/agent — the `kortix-agent` daemon this deploy bakes into sandboxes',
    description:
      'Streams the Linux daemon binary from the API image. `ETag` is its sha256 (the manifest\'s ' +
      '`components.agent.sha256`); send `If-None-Match` to get a 304 instead of the body. 404 ' +
      'when the image carries no agent binary, in which case `components.agent` is absent from ' +
      'the manifest and the caller skips the agent half. The daemon never overwrites its own ' +
      'running binary — it stages the download and its supervisor performs the swap.',
    ...auth,
    responses: {
      200: {
        description: 'The compiled kortix-agent daemon',
        content: { 'application/octet-stream': { schema: z.string() } },
      },
      304: { description: 'Not modified' },
      ...errors(401, 404),
    },
  }),
  (c) => serveAgent(c as never) as never,
);

runtimeAssetsApp.openapi(
  createRoute({
    method: 'get',
    path: '/managed-skills',
    tags: ['runtime-assets'],
    summary: 'GET /runtime-assets/managed-skills — the managed `kortix-*` skill overlay',
    description:
      'Every file of the overlay a sandbox writes to /opt/kortix/managed-skills, byte-identical ' +
      'to what the snapshot builder bakes. `ETag` is the manifest\'s `managed_skills_hash`.',
    ...auth,
    responses: {
      200: json(ManagedSkillsSchema, 'Managed skill overlay files'),
      304: { description: 'Not modified' },
      ...errors(401),
    },
  }),
  (c) => {
    const overlay = managedSkillOverlay();
    const etag = `"${overlay.hash}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
    return c.json({ hash: overlay.hash, files: overlay.files });
  },
);
