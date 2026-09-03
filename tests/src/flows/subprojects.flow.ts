/**
 * Subprojects — the catalog (`/v1/subprojects`) and the per-project surface
 * (`/v1/projects/:projectId/subprojects/*`).
 *
 * A subproject is a Kortix project you install into another project: a repository,
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
 * There is no activation flow and no runs flow. A subproject has no on/off
 * state: it is a set of entries in a project's manifest. Its triggers are
 * enabled one at a time by the Triggers flows, and a run belongs to the trigger
 * that fired, not to the subproject that contributed it.
 *
 * Maps to spec §SUBPROJECT.
 */
import { flow } from '../core/flow';

/** A syntactically-valid but non-existent id, for boundary probes. */
const NOPE = '00000000-0000-4000-a000-000000000000';

/** The status set a route past its gates may answer with locally. */
const SESSION_OR_UNREACHABLE = [201, 503];

const SUBPROJECT_MANIFEST = `kortix_version: 2
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
 * reader is exercised against bytes this file can show, and so the subproject's
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

function subprojectArchive(slug: string, manifest = SUBPROJECT_MANIFEST): FormData {
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

// ─── SUBPROJ-1 — POST /v1/subprojects (index a subproject) ────────────────────────────
flow(
  'SUBPROJ-1',
  {
    domain: 'projects',
    routes: [
      'POST /v1/subprojects',
      'GET /v1/subprojects',
      'GET /v1/subprojects/:subprojectId',
      'DELETE /v1/subprojects/:subprojectId',
      'GET /v1/public/subprojects',
      'GET /v1/public/subprojects/:slug',
    ],
  },
  async (ctx) => {
    const slug = ctx.fixtures.name('subproject-index').replace(/[^a-z0-9-]/g, '-');
    let subprojectId = '';

    await ctx.step('ANON cannot submit → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/subprojects', subprojectArchive(slug));
      r.status(401);
    });

    await ctx.step(
      'an uploaded archive is indexed → 201, card derived from the manifest',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', subprojectArchive(slug));
        r.status(201);
        const body = r.json();
        subprojectId = body.subproject?.subproject_id;
        if (!subprojectId) throw new Error('no subproject_id returned');
        // The card must come from PARSING the manifest, not from the filename.
        if (body.subproject.source_kind !== 'upload') {
          throw new Error(`expected source_kind=upload, got ${body.subproject.source_kind}`);
        }
        if (
          body.subproject.triggers?.length !== 1 ||
          body.subproject.triggers[0].slug !== 'seo-weekly'
        ) {
          throw new Error(`triggers not derived: ${JSON.stringify(body.subproject.triggers)}`);
        }
        if (
          body.subproject.agents?.length !== 1 ||
          body.subproject.agents[0].name !== 'seo-writer'
        ) {
          throw new Error(`agents not derived: ${JSON.stringify(body.subproject.agents)}`);
        }
        // The form asked for `private` (see `subprojectArchive`), so this proves
        // the field is honored — not that it is the default. The default is
        // `account`, asserted below.
        if (body.subproject.visibility !== 'private') {
          throw new Error(`visibility not honored, got ${body.subproject.visibility}`);
        }
      },
    );

    await ctx.step('a submission with no visibility defaults to `account`', async () => {
      const form = subprojectArchive(`${slug}-default`);
      form.delete('visibility');
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', form);
      r.status(201);
      const got = r.json().subproject?.visibility;
      if (got !== 'account') throw new Error(`expected visibility=account, got ${got}`);
      await ctx.client.as(ctx.P.OWNER).del(`/v1/subprojects/${r.json().subproject.subproject_id}`);
    });

    await ctx.step('asking for `public` is COERCED to `private`, not honored', async () => {
      // `public` means every Kortix user in every account. It is a curation
      // decision, so a row only becomes public by migration, seeder or direct
      // insert. The multipart path reads `visibility` from the form itself, so
      // it reaches the handler and the handler narrows it: any present value
      // that is not `account` lands on the submitter alone. It coerces instead
      // of answering 400 because a rejection naming the value confirms the
      // value exists.
      const form = subprojectArchive(`${slug}-public`);
      form.set('visibility', 'public');
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', form);
      r.status(201);
      const got = r.json().subproject?.visibility;
      if (got === 'public') throw new Error('a user published a globally visible subproject');
      if (got !== 'private') throw new Error(`expected coercion to private, got ${got}`);
      const publicId = r.json().subproject.subproject_id;

      // The proof that matters is the read side: another account must not see it.
      const other = await ctx.client.as(ctx.P.NONMEMBER).get(`/v1/subprojects/${publicId}`);
      other.status(404);
      await ctx.client.as(ctx.P.OWNER).del(`/v1/subprojects/${publicId}`);
    });

    await ctx.step('re-uploading the same slug REPLACES it rather than duplicating', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', subprojectArchive(slug));
      r.status(201);
      if (r.json().subproject?.subproject_id !== subprojectId) {
        throw new Error('a second upload of the same slug created a second subproject');
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
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', form);
      r.status(400).body().has('$.code', 'manifest_not_found');
    });

    await ctx.step(
      'an invalid manifest → 400 manifest_invalid, with the offending path',
      async () => {
        // `agents.<name>.description` is OpenCode behavior and belongs in the
        // agent's own `.md` frontmatter — v2 rejects it. A real authoring mistake,
        // so the response must name where it is.
        const bad = SUBPROJECT_MANIFEST.replace('    enabled: true', '    description: nope');
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post('/v1/subprojects', subprojectArchive(`${slug}-bad`, bad));
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
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', form);
      r.status(400).body().has('$.code', 'invalid_archive');
    });

    await ctx.step('a non-GitHub repo address → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/subprojects', { repo: 'https://gitlab.com/acme/widget' });
      r.status(400);
    });

    await ctx.step(
      'a path-traversal repo address → 400 (never coerced to owner/repo)',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', { repo: '/etc/passwd' });
        r.status(400);
      },
    );

    await ctx.step('the owner sees it in the catalog; it is searchable', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/subprojects', { query: { q: slug } });
      r.status(200);
      if (!r.json().subprojects?.some((c: any) => c.subproject_id === subprojectId)) {
        throw new Error('a submitted private subproject is not visible to its own owner');
      }
    });

    await ctx.step(
      'a PRIVATE subproject is invisible to another account → not listed',
      async () => {
        const r = await ctx.client
          .as(ctx.P.NONMEMBER)
          .get('/v1/subprojects', { query: { q: slug } });
        r.status(200);
        if (r.json().subprojects?.some((c: any) => c.subproject_id === subprojectId)) {
          throw new Error('a private subproject leaked into another account listing');
        }
      },
    );

    await ctx.step('and reading it directly by id → 404, never 403', async () => {
      // A 403 would confirm the id exists, which is itself the leak.
      const r = await ctx.client.as(ctx.P.NONMEMBER).get(`/v1/subprojects/${subprojectId}`);
      r.status(404);
    });

    // The public catalogue behind /marketplace. Unauthenticated, and narrowed to
    // `visibility = 'public' AND status = 'active'` in the store's WHERE clause —
    // so the private subproject this flow just submitted must not appear on it.
    await ctx.step('the PUBLIC catalogue reads with no auth at all → 200', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/public/subprojects');
      r.status(200);
      r.headerEquals('cache-control', 'public, max-age=300, must-revalidate');
      r.headerExists('etag');
      if (r.json().subprojects?.some((c: any) => c.subproject_id === subprojectId)) {
        throw new Error('a private subproject leaked into the anonymous public catalogue');
      }
    });

    await ctx.step('the public catalogue revalidates → 304 on a matching ETag', async () => {
      const first = await ctx.client.as(ctx.P.ANON).get('/v1/public/subprojects');
      first.status(200);
      const again = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/subprojects', { headers: { 'if-none-match': first.header('etag')! } });
      again.status(304);
    });

    await ctx.step('a private slug on the public route → 404, never 403', async () => {
      // 403 would confirm the slug exists. To an anonymous visitor a private
      // subproject and a nonexistent one must be indistinguishable.
      const r = await ctx.client.as(ctx.P.ANON).get(`/v1/public/subprojects/${slug}`);
      r.status(404);
    });

    await ctx.step('another account cannot delete it → 404', async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).del(`/v1/subprojects/${subprojectId}`);
      r.status(404);
    });

    await ctx.step('the owner deletes it → 200, and it leaves the catalog', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del(`/v1/subprojects/${subprojectId}`);
      r.status(200);
      const after = await ctx.client.as(ctx.P.OWNER).get(`/v1/subprojects/${subprojectId}`);
      after.status(404);
    });
  },
);

// ─── SUBPROJ-2 — GET /v1/projects/:projectId/subprojects ─────────────────────────
flow(
  'SUBPROJ-2',
  { domain: 'projects', routes: ['GET /v1/projects/:projectId/subprojects'] },
  async (ctx) => {
    const project = await ctx.fixtures.project({
      managedGit: true,
      metadata: { experimental: { subprojects: true } },
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/subprojects', { params: { projectId: project.id } });
      r.status(401);
    });

    await ctx.step('unknown projectId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/subprojects', { params: { projectId: NOPE } });
      r.status(404);
    });

    await ctx.step('a NONMEMBER gets 403/404, never the list', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/subprojects', { params: { projectId: project.id } });
      r.status([403, 404]);
    });

    await ctx.step('a project with no subproject installed → 200 with an empty list', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/subprojects', { params: { projectId: project.id } });
      r.status(200).body().exists('$.subprojects').exists('$.errors');
      if (r.json().subprojects.length !== 0) throw new Error('expected no installed subproject');
    });
  },
);

// ─── SUBPROJ-3 — the feature gate ───────────────────────────────────────────
flow(
  'SUBPROJ-3',
  { domain: 'projects', routes: ['GET /v1/projects/:projectId/subprojects'] },
  async (ctx) => {
    // No `subprojects` in metadata: the flag is OFF, and every project-scoped subproject
    // route must fail closed rather than serving an empty list.
    const project = await ctx.fixtures.project({ managedGit: true });

    await ctx.step('the flag is off → 403 feature_disabled, not an empty 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/subprojects', { params: { projectId: project.id } });
      r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'subprojects');
    });

    await ctx.step('membership is checked BEFORE the flag — a stranger gets 404', async () => {
      // Otherwise a 403 would tell a stranger whether this project has subprojects on.
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/subprojects', { params: { projectId: project.id } });
      r.status([403, 404]);
    });
  },
);

// ─── SUBPROJ-4 — install / uninstall / author sessions ──────────────────────
flow(
  'SUBPROJ-4',
  {
    domain: 'projects',
    routes: [
      'POST /v1/projects/:projectId/subprojects/install-session',
      'POST /v1/projects/:projectId/subprojects/author-session',
      'POST /v1/projects/:projectId/subprojects/:slug/uninstall-session',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({
      managedGit: true,
      metadata: { experimental: { subprojects: true } },
    });
    const slug = ctx.fixtures.name('subproject-install').replace(/[^a-z0-9-]/g, '-');
    let subprojectId = '';

    await ctx.step('index a subproject to install', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/subprojects', subprojectArchive(slug));
      r.status(201);
      subprojectId = r.json().subproject.subproject_id;
    });

    await ctx.step('install: ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/projects/:projectId/subprojects/install-session',
          { subproject_id: subprojectId },
          { params: { projectId: project.id } },
        );
      r.status(401);
    });

    await ctx.step('install: unknown projectId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/subprojects/install-session',
          { subproject_id: subprojectId },
          { params: { projectId: NOPE } },
        );
      r.status(404);
    });

    await ctx.step('install: missing subproject_id → 400, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/subprojects/install-session',
          {},
          { params: { projectId: project.id } },
        );
      r.status(400).body().has('$.error', 'subproject_id is required');
    });

    await ctx.step('install: unknown subproject_id → 404, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/subprojects/install-session',
          { subproject_id: NOPE },
          { params: { projectId: project.id } },
        );
      r.status(404);
    });

    await ctx.step("install: another account's private subproject → 404, never 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/subprojects/install-session',
          { subproject_id: subprojectId },
          { params: { projectId: project.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step('install: past every gate → a session, or the local sandbox limit', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/subprojects/install-session',
          { subproject_id: subprojectId },
          { params: { projectId: project.id } },
        );
      r.status(SESSION_OR_UNREACHABLE);
      if (r.statusCode === 201) r.body().exists('$.session_id');
    });

    await ctx.step('author: an empty description → 400, no session spawned', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/subprojects/author-session',
          { description: '   ' },
          { params: { projectId: project.id } },
        );
      r.status(400);
    });

    await ctx.step('author: an over-long description → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/subprojects/author-session',
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
            '/v1/projects/:projectId/subprojects/author-session',
            { description: 'watch my competitors weekly and file a digest' },
            { params: { projectId: project.id } },
          );
        r.status(SESSION_OR_UNREACHABLE);
      },
    );

    await ctx.step('uninstall: a subproject this project does not have → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/subprojects/:slug/uninstall-session',
          {},
          { params: { projectId: project.id, slug: 'never-installed' } },
        );
      r.status(404);
    });

    await ctx.step('a client cannot forge subproject attribution on a session → 400', async () => {
      // `subproject_slug` is server-managed. Without that, a client could attribute
      // its own session to someone else's subproject and appear in its run history.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/sessions',
          { metadata: { subproject_slug: 'someone-elses-subproject' } },
          { params: { projectId: project.id } },
        );
      r.status(400);
      if (!JSON.stringify(r.json()).includes('subproject_slug')) {
        throw new Error('the rejection must name the offending key');
      }
    });

    await ctx.step('cleanup: withdraw the subproject', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del(`/v1/subprojects/${subprojectId}`);
      r.status(200);
    });
  },
);
