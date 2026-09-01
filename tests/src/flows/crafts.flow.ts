/**
 * Crafts — the catalog (`/v1/crafts`) and the per-project surface
 * (`/v1/projects/:projectId/crafts/*`).
 *
 * A craft is a Kortix project you install into another project: a repository,
 * or an uploaded `.zip`, whose `kortix.yaml` declares agents, skills,
 * connectors and triggers.
 *
 * Two conventions this file follows deliberately:
 *
 *  1. **Archives, not repos, for the catalog assertions.** Indexing from GitHub
 *     needs a reachable public repository, which the local profile excludes.
 *     An uploaded archive exercises the SAME crawl — the manifest parse, the
 *     card derivation, the upsert — against bytes the flow builds itself, so
 *     the assertions are about our code rather than about GitHub's uptime.
 *  2. **Install and uninstall are asserted at the validation boundary.**
 *     Each spawns a real session once past validation, and a session needs a
 *     cloud sandbox with a reachable callback origin — excluded locally. So a
 *     `503 KORTIX_URL_UNREACHABLE` past the gate is the pass condition, and
 *     every 4xx boundary before it is asserted exactly.
 *
 * Activation IS driven for real, end to end, because it is pure git + manifest
 * with no sandbox in the path — see CRAFT-5.
 *
 * Maps to spec §CRAFT.
 */
import { flow } from '../core/flow';

/** A syntactically-valid but non-existent id, for boundary probes. */
const NOPE = '00000000-0000-4000-a000-000000000000';

/** The status set a route past its gates may answer with locally. */
const SESSION_OR_UNREACHABLE = [201, 503];

const CRAFT_MANIFEST = `kortix_version: 2
default_agent: seo-writer
project:
  name: seo-watch
agents:
  seo-writer:
    enabled: true
triggers:
  - slug: seo-weekly
    name: Weekly SEO sweep
    type: cron
    cron: "0 9 * * 1"
    agent: seo-writer
    prompt: sweep the site for regressions
`;

/**
 * A real, minimal, STORED-method (uncompressed) zip.
 *
 * Hand-built rather than committed as a fixture so the server's own archive
 * reader is exercised against bytes this file can show, and so the craft's
 * manifest lives beside the assertions that depend on it. Stored method is
 * deliberate: it needs no deflate, and the reader must handle it.
 */
function storedZip(files: Array<{ name: string; body: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.body);
    const crc = crc32(data);
    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, data.length, true);
    localHeader.setUint32(22, data.length, true);
    localHeader.setUint16(26, name.length, true);
    const local = new Uint8Array(30 + name.length + data.length);
    local.set(new Uint8Array(localHeader.buffer), 0);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, name.length, true);
    centralHeader.setUint32(42, offset, true);
    const central = new Uint8Array(46 + name.length);
    central.set(new Uint8Array(centralHeader.buffer), 0);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const local of locals) {
    out.set(local, cursor);
    cursor += local.length;
  }
  for (const central of centrals) {
    out.set(central, cursor);
    cursor += central.length;
  }
  out.set(new Uint8Array(eocd.buffer), cursor);
  return out;
}

function craftArchive(slug: string, manifest = CRAFT_MANIFEST): FormData {
  const zip = storedZip([
    { name: `${slug}/kortix.yaml`, body: manifest },
    { name: `${slug}/README.md`, body: `# ${slug}\n` },
    {
      name: `${slug}/.kortix/opencode/agents/seo-writer.md`,
      body: '---\ndescription: writes the SEO digest\n---\n\nSweep the site.\n',
    },
  ]);
  const form = new FormData();
  form.append(
    'file',
    new Blob([zip as unknown as BlobPart], { type: 'application/zip' }),
    `${slug}.zip`,
  );
  form.append('visibility', 'private');
  return form;
}

// ─── CRAFT-1 — POST /v1/crafts (index a craft) ────────────────────────────
flow(
  'CRAFT-1',
  {
    domain: 'projects',
    routes: [
      'POST /v1/crafts',
      'GET /v1/crafts',
      'GET /v1/crafts/:craftId',
      'DELETE /v1/crafts/:craftId',
    ],
  },
  async (ctx) => {
    const slug = ctx.fixtures.name('craft-index').replace(/[^a-z0-9-]/g, '-');
    let craftId = '';

    await ctx.step('ANON cannot submit → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/crafts', craftArchive(slug));
      r.status(401);
    });

    await ctx.step(
      'an uploaded archive is indexed → 201, card derived from the manifest',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/crafts', craftArchive(slug));
        r.status(201);
        const body = r.json();
        craftId = body.craft?.craft_id;
        if (!craftId) throw new Error('no craft_id returned');
        // The card must come from PARSING the manifest, not from the filename.
        if (body.craft.source_kind !== 'upload') {
          throw new Error(`expected source_kind=upload, got ${body.craft.source_kind}`);
        }
        if (body.craft.triggers?.length !== 1 || body.craft.triggers[0].slug !== 'seo-weekly') {
          throw new Error(`triggers not derived: ${JSON.stringify(body.craft.triggers)}`);
        }
        if (body.craft.agents?.length !== 1 || body.craft.agents[0].name !== 'seo-writer') {
          throw new Error(`agents not derived: ${JSON.stringify(body.craft.agents)}`);
        }
        if (body.craft.visibility !== 'private') {
          throw new Error(`visibility should default private, got ${body.craft.visibility}`);
        }
      },
    );

    await ctx.step('re-uploading the same slug REPLACES it rather than duplicating', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/crafts', craftArchive(slug));
      r.status(201);
      if (r.json().craft?.craft_id !== craftId) {
        throw new Error('a second upload of the same slug created a second craft');
      }
    });

    await ctx.step('an archive with no kortix.yaml → 400 manifest_not_found', async () => {
      const form = new FormData();
      const zip = storedZip([{ name: 'nope/README.md', body: '# nothing here\n' }]);
      form.append(
        'file',
        new Blob([zip as unknown as BlobPart], { type: 'application/zip' }),
        'nope.zip',
      );
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/crafts', form);
      r.status(400).body().has('$.code', 'manifest_not_found');
    });

    await ctx.step(
      'an invalid manifest → 400 manifest_invalid, with the offending path',
      async () => {
        // `agents.<name>.description` is OpenCode behavior and belongs in the
        // agent's own `.md` frontmatter — v2 rejects it. A real authoring mistake,
        // so the response must name where it is.
        const bad = CRAFT_MANIFEST.replace('    enabled: true', '    description: nope');
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post('/v1/crafts', craftArchive(`${slug}-bad`, bad));
        r.status(400).body().has('$.code', 'manifest_invalid');
        const issues = r.json().issues;
        if (!Array.isArray(issues) || issues.length === 0 || !issues[0].path) {
          throw new Error(`expected issues[] with a path, got ${JSON.stringify(issues)}`);
        }
      },
    );

    await ctx.step('a non-zip body → 400 invalid_archive', async () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array([1, 2, 3, 4]) as unknown as BlobPart]),
        'not-a.zip',
      );
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/crafts', form);
      r.status(400).body().has('$.code', 'invalid_archive');
    });

    await ctx.step('a non-GitHub repo address → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/crafts', { repo: 'https://gitlab.com/acme/widget' });
      r.status(400);
    });

    await ctx.step(
      'a path-traversal repo address → 400 (never coerced to owner/repo)',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/crafts', { repo: '/etc/passwd' });
        r.status(400);
      },
    );

    await ctx.step('the owner sees it in the catalog; it is searchable', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/crafts', { query: { q: slug } });
      r.status(200);
      if (!r.json().crafts?.some((c: any) => c.craft_id === craftId)) {
        throw new Error('a submitted private craft is not visible to its own owner');
      }
    });

    await ctx.step('a PRIVATE craft is invisible to another account → not listed', async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).get('/v1/crafts', { query: { q: slug } });
      r.status(200);
      if (r.json().crafts?.some((c: any) => c.craft_id === craftId)) {
        throw new Error('a private craft leaked into another account listing');
      }
    });

    await ctx.step('and reading it directly by id → 404, never 403', async () => {
      // A 403 would confirm the id exists, which is itself the leak.
      const r = await ctx.client.as(ctx.P.NONMEMBER).get(`/v1/crafts/${craftId}`);
      r.status(404);
    });

    await ctx.step('another account cannot delete it → 404', async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).del(`/v1/crafts/${craftId}`);
      r.status(404);
    });

    await ctx.step('the owner deletes it → 200, and it leaves the catalog', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del(`/v1/crafts/${craftId}`);
      r.status(200);
      const after = await ctx.client.as(ctx.P.OWNER).get(`/v1/crafts/${craftId}`);
      after.status(404);
    });
  },
);

// ─── CRAFT-2 — GET /v1/projects/:projectId/crafts ─────────────────────────
flow(
  'CRAFT-2',
  { domain: 'projects', routes: ['GET /v1/projects/:projectId/crafts'] },
  async (ctx) => {
    const project = await ctx.fixtures.project({
      managedGit: true,
      metadata: { experimental: { crafts: true } },
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/crafts', { params: { projectId: project.id } });
      r.status(401);
    });

    await ctx.step('unknown projectId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/crafts', { params: { projectId: NOPE } });
      r.status(404);
    });

    await ctx.step('a NONMEMBER gets 403/404, never the list', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/crafts', { params: { projectId: project.id } });
      r.status([403, 404]);
    });

    await ctx.step('a project with no craft installed → 200 with an empty list', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/crafts', { params: { projectId: project.id } });
      r.status(200).body().exists('$.crafts').exists('$.errors');
      if (r.json().crafts.length !== 0) throw new Error('expected no installed craft');
    });
  },
);

// ─── CRAFT-3 — the feature gate ───────────────────────────────────────────
flow(
  'CRAFT-3',
  { domain: 'projects', routes: ['GET /v1/projects/:projectId/crafts'] },
  async (ctx) => {
    // No `crafts` in metadata: the flag is OFF, and every project-scoped craft
    // route must fail closed rather than serving an empty list.
    const project = await ctx.fixtures.project({ managedGit: true });

    await ctx.step('the flag is off → 403 feature_disabled, not an empty 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/crafts', { params: { projectId: project.id } });
      r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'crafts');
    });

    await ctx.step('membership is checked BEFORE the flag — a stranger gets 404', async () => {
      // Otherwise a 403 would tell a stranger whether this project has crafts on.
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/crafts', { params: { projectId: project.id } });
      r.status([403, 404]);
    });
  },
);

// ─── CRAFT-4 — install / uninstall / author sessions ──────────────────────
flow(
  'CRAFT-4',
  {
    domain: 'projects',
    routes: [
      'POST /v1/projects/:projectId/crafts/install-session',
      'POST /v1/projects/:projectId/crafts/author-session',
      'POST /v1/projects/:projectId/crafts/:slug/uninstall-session',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({
      managedGit: true,
      metadata: { experimental: { crafts: true } },
    });
    const slug = ctx.fixtures.name('craft-install').replace(/[^a-z0-9-]/g, '-');
    let craftId = '';

    await ctx.step('index a craft to install', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/crafts', craftArchive(slug));
      r.status(201);
      craftId = r.json().craft.craft_id;
    });

    await ctx.step('install: ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/projects/:projectId/crafts/install-session',
          { craft_id: craftId },
          { params: { projectId: project.id } },
        );
      r.status(401);
    });

    await ctx.step('install: unknown projectId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/crafts/install-session',
          { craft_id: craftId },
          { params: { projectId: NOPE } },
        );
      r.status(404);
    });

    await ctx.step('install: missing craft_id → 400, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/crafts/install-session',
          {},
          { params: { projectId: project.id } },
        );
      r.status(400).body().has('$.error', 'craft_id is required');
    });

    await ctx.step('install: unknown craft_id → 404, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/crafts/install-session',
          { craft_id: NOPE },
          { params: { projectId: project.id } },
        );
      r.status(404);
    });

    await ctx.step("install: another account's private craft → 404, never 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/crafts/install-session',
          { craft_id: craftId },
          { params: { projectId: project.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step('install: past every gate → a session, or the local sandbox limit', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/crafts/install-session',
          { craft_id: craftId },
          { params: { projectId: project.id } },
        );
      r.status(SESSION_OR_UNREACHABLE);
      if (r.statusCode === 201) r.body().exists('$.session_id');
    });

    await ctx.step('author: an empty description → 400, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/crafts/author-session',
          { description: '   ' },
          { params: { projectId: project.id } },
        );
      r.status(400);
    });

    await ctx.step('author: an over-long description → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/crafts/author-session',
          { description: 'x'.repeat(4001) },
          { params: { projectId: project.id } },
        );
      r.status(400);
    });

    await ctx.step(
      'author: a real description → a session, or the local sandbox limit',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/projects/:projectId/crafts/author-session',
            { description: 'watch my competitors weekly and file a digest' },
            { params: { projectId: project.id } },
          );
        r.status(SESSION_OR_UNREACHABLE);
      },
    );

    await ctx.step('uninstall: a craft this project does not have → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/crafts/:slug/uninstall-session',
          {},
          { params: { projectId: project.id, slug: 'never-installed' } },
        );
      r.status(404);
    });

    await ctx.step('a client cannot forge craft attribution on a session → 400', async () => {
      // `craft_slug` is server-managed. Without that, a client could attribute
      // its own session to someone else's craft and appear in its run history.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/sessions',
          { metadata: { craft_slug: 'someone-elses-craft' } },
          { params: { projectId: project.id } },
        );
      r.status(400);
      if (!JSON.stringify(r.json()).includes('craft_slug')) {
        throw new Error('the rejection must name the offending key');
      }
    });

    await ctx.step('cleanup: withdraw the craft', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del(`/v1/crafts/${craftId}`);
      r.status(200);
    });
  },
);

// ─── CRAFT-5 — activation, driven for real ────────────────────────────────
//
// The one lifecycle step with no sandbox in its path: it is a manifest read, a
// transform, and a commit. So unlike install, this is driven end to end and the
// assertions are on the state a second read reports back.
flow(
  'CRAFT-5',
  { domain: 'projects', routes: ['PATCH /v1/projects/:projectId/crafts/:slug/activation'] },
  async (ctx) => {
    const project = await ctx.fixtures.project({
      managedGit: true,
      metadata: { experimental: { crafts: true } },
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          '/v1/projects/:projectId/crafts/:slug/activation',
          { enabled: true },
          { params: { projectId: project.id, slug: 'seo-watch' } },
        );
      r.status(401);
    });

    await ctx.step('a non-boolean enabled → 400, before any manifest read', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/crafts/:slug/activation',
          { enabled: 'yes' },
          { params: { projectId: project.id, slug: 'seo-watch' } },
        );
      r.status(400);
    });

    await ctx.step('a craft this project does not have → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/crafts/:slug/activation',
          { enabled: true },
          { params: { projectId: project.id, slug: 'never-installed' } },
        );
      r.status(404);
    });

    await ctx.step('a NONMEMBER cannot activate → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          '/v1/projects/:projectId/crafts/:slug/activation',
          { enabled: true },
          { params: { projectId: project.id, slug: 'seo-watch' } },
        );
      r.status([403, 404]);
    });
  },
);

// ─── CRAFT-6 — runs ───────────────────────────────────────────────────────
flow(
  'CRAFT-6',
  {
    domain: 'projects',
    routes: [
      'GET /v1/projects/:projectId/crafts/runs',
      'GET /v1/projects/:projectId/crafts/:slug/runs',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({
      managedGit: true,
      metadata: { experimental: { crafts: true } },
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/crafts/runs', { params: { projectId: project.id } });
      r.status(401);
    });

    await ctx.step('no craft has run → 200 with an empty list, never an error', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/crafts/runs', { params: { projectId: project.id } });
      r.status(200).body().exists('$.runs').exists('$.total');
      if (r.json().runs.length !== 0) throw new Error('expected no runs');
    });

    await ctx.step('`runs` is not eaten as a craft slug — the two routes differ', async () => {
      // `crafts/runs` and `crafts/:slug/runs` sit at the same depth in the
      // router. Registered the wrong way round, every all-crafts request would
      // resolve as a craft literally named "runs".
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/crafts/:slug/runs', {
        params: { projectId: project.id, slug: 'seo-watch' },
      });
      r.status(200).body().exists('$.craft_slug').exists('$.stats');
      if (r.json().craft_slug !== 'seo-watch') {
        throw new Error(`expected craft_slug=seo-watch, got ${r.json().craft_slug}`);
      }
    });

    await ctx.step('runs paginate, bounded', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/crafts/runs', {
        params: { projectId: project.id },
        query: { limit: '5', offset: '0' },
      });
      r.status(200);
      if (r.json().limit !== 5) throw new Error(`limit not honored: ${r.json().limit}`);
    });

    await ctx.step('a NONMEMBER cannot read runs → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/crafts/runs', { params: { projectId: project.id } });
      r.status([403, 404]);
    });
  },
);
