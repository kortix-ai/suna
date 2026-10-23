/**
 * ART-1..2 — Artifacts: paths of the project's Files volume shared as docs
 * (Markdown) and pages (HTML) (flag `artifacts`). Contract:
 * tests/spec/end-to-end.md §36. The files live in Files (Platinum); on a target
 * without volume storage the first publish answers 503 and the flows assert that.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { CliSandbox, type CliResult } from '../fixtures/cli';
import { bindDatabaseSessionCredential, createDatabaseSession } from '../fixtures/database-project';

const LIST = '/v1/projects/:projectId/artifacts';
const SHARE = '/v1/projects/:projectId/artifacts/share';
const TYPES = '/v1/projects/:projectId/artifacts/types';
const ONE = '/v1/projects/:projectId/artifacts/:artifactId';
const PIN = '/v1/projects/:projectId/artifacts/:artifactId/pin';
const VERSIONS = '/v1/projects/:projectId/artifacts/:artifactId/versions';
const RESTORE = '/v1/projects/:projectId/artifacts/:artifactId/restore';
const CONTENT = '/v1/projects/:projectId/artifacts/:artifactId/content';

type Detail = {
  artifact_id: string; title: string; type: string; path: string; entry: string; visibility: string;
  can_edit: boolean; can_manage: boolean; pinned: boolean; entry_version: string | null;
  view_url: string; public_url: string | null; public_content_url: string | null;
  version: { id: string | null; files: { path: string }[]; view_url: string };
};

/** A 1×1 PNG: binary bytes must survive the CLI's base64 upload unchanged. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

const DOC_V1 = '# Churn report\n\nChurn fell to **2.1%**.\n\n- [x] measured\n- [ ] announced\n';
const DOC_V2 = DOC_V1.replace('2.1%', '1.9%');

/** Turn the flag on; false when this target has no volume storage (the flag cannot be on). */
async function enableArtifacts(ctx: FlowContext, projectId: string): Promise<boolean> {
  const r = (await ctx.client.as(ctx.P.OWNER).patch('/v1/projects/:projectId/features', { feature: 'artifacts', enabled: true }, { params: { projectId } })).status(200);
  return r.json<{ experimental: Record<string, boolean> }>().experimental.artifacts === true;
}

async function get(url: string) {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function ok(result: CliResult, what: string, code = 0): CliResult {
  if (result.exitCode !== code) throw new Error(`${what}: exit ${result.exitCode} (want ${code}): ${result.all.slice(0, 800)}`);
  return result;
}

flow(
  'ART-1',
  {
    domain: 'artifacts',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: [
      'PATCH /v1/projects/:projectId/features',
      `GET ${TYPES}`, `GET ${LIST}`, `POST ${LIST}`, `POST ${SHARE}`, `GET ${ONE}`, `PUT ${ONE}`, `PATCH ${ONE}`, `DELETE ${ONE}`,
      `PUT ${PIN}`, `DELETE ${PIN}`, `GET ${VERSIONS}`, `POST ${RESTORE}`, `GET ${CONTENT}`,
      'GET /v1/artifacts/s/:token', 'GET /v1/artifacts/s/:token/*', 'GET /v1/artifacts/p/:artifactId', 'GET /v1/artifacts/p/:artifactId/*', 'GET /v1/artifacts/meta/:artifactId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'user');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const p = { projectId: project.id };
    let doc = '';
    let docPath = '';
    let page = '';
    const one = (artifactId = doc) => ({ params: { projectId: project.id, artifactId } });

    await ctx.step('ANON → 401; flag off (the default) → 403 feature_disabled', async () => {
      (await ctx.client.as(ctx.P.ANON).get(LIST, { params: p })).status(401);
      (await owner.get(LIST, { params: p })).status(403).body().has('$.code', 'feature_disabled');
    });

    if (!(await enableArtifacts(ctx, project.id))) {
      await ctx.step('no volume storage on this target: the flag stays off → 403', async () => {
        (await owner.get(LIST, { params: p })).status(403);
      });
      return;
    }

    await ctx.step('GET types → doc and html, each with a format and a starter', async () => {
      const types = (await owner.get(TYPES, { params: p })).status(200).json<{ types: { type: string; starter: string; format: string }[] }>().types;
      if (types.map((t) => t.type).sort().join() !== 'doc,html') throw new Error(JSON.stringify(types.map((t) => t.type)));
      if (types.some((t) => !t.starter || !t.format)) throw new Error('a type lacks its starter or format');
    });

    await ctx.step('a publish without index.md or index.html → 400 missing_entry; a path with .. → 400 invalid_path', async () => {
      (await owner.post(LIST, { files: { 'a.css': { content: 'x' } } }, { params: p })).status(400).body().has('$.code', 'missing_entry');
      (await owner.post(LIST, { files: { 'index.html': { content: 'x' }, '../x': { content: 'x' } } }, { params: p })).status(400).body().has('$.code', 'invalid_path');
    });

    let storage = true;
    await ctx.step('OWNER publishes index.md (+ notes.md) → 201: a doc, private, stored as a folder in their folder in Files, titled by its heading (503 without volume storage)', async () => {
      const r = await owner.post(LIST, { files: { 'index.md': { content: DOC_V1 }, 'notes.md': { content: '# Notes\n' } } }, { params: p });
      if (r.statusCode === 503) {
        r.body().has('$.code', 'drive_storage_unavailable');
        storage = false;
        return;
      }
      const a = r.status(201).json<Detail>();
      if (a.title !== 'Churn report' || a.type !== 'doc' || a.visibility !== 'private' || !a.can_edit || !a.can_manage || !a.entry_version) throw new Error(JSON.stringify(a));
      if (!/^\/Users\/[^/]+\/Artifacts\/churn-report$/.test(a.path) || a.version.files.map((f) => f.path).join() !== 'index.md,notes.md') throw new Error(`${a.path} ${JSON.stringify(a.version.files)}`);
      doc = a.artifact_id;
      docPath = a.path;
    });
    if (!storage) return;

    await ctx.step('the signed view_url renders the Markdown with the doc stylesheet as a CSP sandbox and keeps one URL across reads; ?print=1 adds the print call; a lone file cannot be shared (400 share_folder) and its index file names the folder (409 already_shared); a forged token → 404; no trailing slash → 301', async () => {
      const a = (await owner.get(ONE, one())).status(200).json<Detail>();
      const view = await get(a.view_url);
      if (view.status !== 200 || !view.headers.get('content-type')?.startsWith('text/html')) throw new Error(`view ${view.status} ${view.headers.get('content-type')}`);
      const csp = view.headers.get('content-security-policy') ?? '';
      // Opaque on the API host; the page's own origin only on a separate content host (ARTIFACT_CONTENT_URL).
      const ownHost = new URL(a.view_url).host !== new URL(ctx.env.apiUrl).host;
      if (!/sandbox allow-scripts/.test(csp) || /allow-same-origin/.test(csp) !== ownHost) throw new Error(`CSP ${csp}`);
      if ((await owner.get(ONE, one())).json<Detail>().view_url !== a.view_url) throw new Error('the view URL changed between two reads');
      if (!view.text.includes('class="kx-doc"') || !view.text.includes('<strong>2.1%</strong>') || !view.text.includes('data-type="taskList"')) throw new Error(view.text.slice(0, 400));
      if (!(await get(`${a.view_url}?print=1`)).text.includes('print()')) throw new Error('?print=1 does not open the print dialog');
      // An artifact is always a folder: a lone file is refused, an index file stands for its folder.
      (await owner.post(SHARE, { path: `${docPath}/notes.md` }, { params: p })).status(400).body().has('$.code', 'share_folder');
      (await owner.post(SHARE, { path: `${docPath}/index.md` }, { params: p })).status(409).body().has('$.code', 'already_shared');
      if ((await get(a.view_url.replace(/\/s\/[^.]+/, '/s/forged'))).status !== 404) throw new Error('a forged token served');
      const bare = await get(a.view_url.replace(/\/$/, ''));
      if (bare.status !== 301 || !bare.headers.get('location')?.endsWith('/')) throw new Error(`bare view URL ${bare.status}`);
    });

    await ctx.step('OWNER publishes a folder (index.html + style.css) → an html artifact; style.css resolves relative to the page; an unknown path → 404', async () => {
      const a = (await owner.post(LIST, { files: { 'index.html': { content: '<!doctype html><title>Deck</title><link rel="stylesheet" href="style.css"><h1>Deck</h1>' }, 'style.css': { content: 'h1{color:red}' } } }, { params: p })).status(201).json<Detail>();
      if (a.type !== 'html' || a.title !== 'Deck' || !/\/Artifacts\/deck$/.test(a.path) || a.version.files.map((f) => f.path).join() !== 'index.html,style.css') throw new Error(JSON.stringify(a));
      page = a.artifact_id;
      const css = await get(`${a.view_url}style.css`);
      if (css.status !== 200 || css.text !== 'h1{color:red}' || !css.headers.get('content-type')?.startsWith('text/css')) throw new Error(`css ${css.status}`);
      if ((await get(`${a.view_url}nope.js`)).status !== 404) throw new Error('unknown path served');
    });

    await ctx.step('a private artifact is invisible to a project member: list leaves it out, GET → 404; NONMEMBER → 403/404', async () => {
      // Each API process caches membership up to 15 s: wait until the new member is let in.
      const deadline = Date.now() + 45_000;
      while ((await asMember.get(LIST, { params: p })).statusCode !== 200) {
        if (Date.now() > deadline) throw new Error('the new member never reached the artifact list');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const list = (await asMember.get(LIST, { params: p })).status(200).json<{ artifacts: Detail[] }>().artifacts;
      if (list.some((x) => x.artifact_id === doc)) throw new Error('member lists a private artifact');
      (await asMember.get(ONE, one())).status(404);
      (await ctx.client.as(ctx.P.NONMEMBER).get(ONE, one())).status([403, 404]);
    });

    await ctx.step("shared with the member: they read it, but saving (its file is in OWNER's own folder) and resharing → 403 artifact_read_only", async () => {
      (await owner.patch(ONE, { shared_with_user_ids: [member.userId] }, one())).status(200);
      const a = (await asMember.get(ONE, one())).status(200).json<Detail>();
      if (a.can_edit || a.can_manage) throw new Error(JSON.stringify({ can_edit: a.can_edit, can_manage: a.can_manage }));
      (await asMember.put(ONE, { files: { 'index.md': { content: 'x' } } }, one())).status(403).body().has('$.code', 'artifact_read_only');
      (await asMember.patch(ONE, { visibility: 'public' }, one())).status(403);
    });

    await ctx.step("visibility project: every member lists it; the member cannot share a path in OWNER's folder (404)", async () => {
      (await owner.patch(ONE, { visibility: 'project', shared_with_user_ids: [] }, one())).status(200);
      const list = (await asMember.get(LIST, { params: p })).status(200).json<{ artifacts: Detail[] }>().artifacts;
      if (!list.some((x) => x.artifact_id === doc)) throw new Error('member does not list a project artifact');
      (await asMember.post(SHARE, { path: docPath }, { params: p })).status(404);
    });

    await ctx.step('saving with base_version writes the file in Files; a save from the old version → 409 version_conflict', async () => {
      const before = (await owner.get(ONE, one())).status(200).json<Detail>().entry_version;
      const a = (await owner.put(ONE, { base_version: before, files: { 'index.md': { content: DOC_V2 } } }, one())).status(200).json<Detail>();
      if (!a.entry_version || a.entry_version === before) throw new Error('the save did not move the version');
      (await owner.put(ONE, { base_version: before, files: { 'index.md': { content: 'stale' } } }, one())).status(409).body().has('$.code', 'version_conflict');
      const now = (await owner.get(CONTENT, one())).status(200).text();
      if (!now.includes('1.9%')) throw new Error(now);
    });

    await ctx.step('versions come from the Files history: two saves; the old one reads 2.1%; restoring it writes it back as a third save', async () => {
      const versions = (await owner.get(VERSIONS, one())).status(200).json<{ versions: { id: string; number: number }[] }>().versions;
      if (versions.length !== 2 || versions[0]!.number !== 2) throw new Error(JSON.stringify(versions));
      const old = (await owner.get(CONTENT, { ...one(), query: { version: versions[1]!.id } })).status(200).text();
      if (!old.includes('2.1%')) throw new Error(old);
      const atOld = (await owner.get(ONE, { ...one(), query: { version: versions[1]!.id } })).status(200).json<Detail>();
      if (!(await get(atOld.version.view_url)).text.includes('2.1%')) throw new Error('the old version view does not show the old page');
      (await owner.post(RESTORE, { version: versions[1]!.id }, one())).status(200);
      if (!(await owner.get(CONTENT, one())).status(200).text().includes('2.1%')) throw new Error('restore did not bring 2.1% back');
      const after = (await owner.get(VERSIONS, one())).status(200).json<{ versions: unknown[] }>().versions;
      if (after.length !== 3) throw new Error(`versions after restore: ${after.length}`);
    });

    await ctx.step('pin is personal: pinned for OWNER, listed under scope=pinned, not pinned for the member', async () => {
      (await owner.put(PIN, undefined, one())).status(200).body().has('$.pinned', true);
      const pinned = (await owner.get(LIST, { params: p, query: { scope: 'pinned' } })).status(200).json<{ artifacts: Detail[] }>().artifacts;
      if (pinned.map((x) => x.artifact_id).join() !== doc) throw new Error('pinned scope');
      (await asMember.get(ONE, one())).status(200).body().has('$.pinned', false);
      (await owner.del(PIN, one())).status(200).body().has('$.pinned', false);
    });

    await ctx.step('public: the raw page and its meta serve without a login; back to private → both 404 at once', async () => {
      const a = (await owner.patch(ONE, { visibility: 'public' }, one())).status(200).json<Detail>();
      if (!a.public_url?.includes(`/share/artifact/${doc}`) || !a.public_content_url) throw new Error(JSON.stringify(a));
      const pub = await get(a.public_content_url);
      if (pub.status !== 200 || !pub.text.includes('Churn report')) throw new Error(`public ${pub.status}`);
      const bare = await get(a.public_content_url.replace(/\/$/, ''));
      if (bare.status !== 301 || !bare.headers.get('location')?.endsWith(`/p/${doc}/`)) throw new Error(`bare public URL ${bare.status}`);
      const meta = await get(`${ctx.env.apiUrl}/artifacts/meta/${doc}`);
      if (meta.status !== 200 || JSON.parse(meta.text).title !== 'Churn report') throw new Error(`meta ${meta.status}`);
      (await owner.patch(ONE, { visibility: 'private' }, one())).status(200);
      if ((await get(a.public_content_url)).status !== 404) throw new Error('revoked public link still serves');
      if ((await get(`${ctx.env.apiUrl}/artifacts/meta/${doc}`)).status !== 404) throw new Error('revoked meta still answers');
    });

    await ctx.step('the member cannot unshare; OWNER unshares → GET 404, the signed URL 404; the file stays in Files, so sharing its path again → 201; the same path twice → 409', async () => {
      const viewUrl = (await owner.get(ONE, one())).status(200).json<Detail>().view_url;
      (await asMember.del(ONE, one())).status([403, 404]);
      (await owner.del(ONE, one())).status(200);
      (await owner.get(ONE, one())).status(404);
      if ((await get(viewUrl)).status !== 404) throw new Error('an unshared artifact still serves');
      const again = (await owner.post(SHARE, { path: docPath }, { params: p })).status(201).json<Detail>();
      if (again.type !== 'doc' || again.title !== 'Churn report') throw new Error(JSON.stringify(again));
      (await owner.post(SHARE, { path: docPath }, { params: p })).status(409).body().has('$.code', 'already_shared');
      (await owner.post(SHARE, { path: `${docPath}.missing` }, { params: p })).status(404);
      (await owner.del(ONE, one(again.artifact_id))).status(200);
      (await owner.del(ONE, one(page))).status(200);
    });
  },
);

flow(
  'ART-2',
  {
    domain: 'artifacts',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: ['POST /v1/projects/:projectId/cli-token', `GET ${LIST}`, `POST ${LIST}`, `POST ${SHARE}`, `PUT ${ONE}`, `PATCH ${ONE}`, `GET ${ONE}`, `GET ${CONTENT}`, `GET ${VERSIONS}`, `DELETE ${ONE}`],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    if (!(await enableArtifacts(ctx, project.id))) {
      await ctx.step('no volume storage on this target: nothing to publish', async () => {});
      return;
    }
    const probe = await ctx.client.as(ctx.P.OWNER).post(LIST, { files: { 'index.md': { content: '# probe' } } }, { params: { projectId: project.id } });
    if (probe.statusCode === 503) {
      await ctx.step('no volume storage on this target → publish 503 drive_storage_unavailable', async () => {
        probe.body().has('$.code', 'drive_storage_unavailable');
      });
      return;
    }
    probe.status(201);
    const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'project', metadata: { name: 'Writer' } });
    ctx.track('session', sessionId, { projectId: project.id });
    const minted = (await ctx.client.as(ctx.P.OWNER).post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('art') }, { params: { projectId: project.id } })).status(201)
      .json<{ token_id: string; secret_key: string }>();
    await bindDatabaseSessionCredential(ctx.env, { tokenId: minted.token_id, commandId: crypto.randomUUID(), sessionId, accountId: team.id, projectId: project.id });
    const sandbox = new CliSandbox('artifacts');
    const env = { KORTIX_TOKEN: minted.secret_key, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: project.id, KORTIX_SESSION_ID: sessionId, KORTIX_FEATURE_FLAGS: 'artifacts' };
    const run = (args: string[]) => sandbox.run(args, { env });
    let page = '';
    let doc = '';
    let docPath = '';
    try {
      await ctx.step('`types html --starter` prints a page; the agent publishes a folder (index.html + app.js + cards/*.png) → html, in Files, recorded with its session; each image serves byte for byte', async () => {
        const starter = ok(await run(['artifacts', 'types', 'html', '--starter']), 'types').stdout;
        if (!starter.includes('<html')) throw new Error(starter.slice(0, 200));
        sandbox.writeFile('deck/index.html', starter.replace('<title>Untitled page</title>', '<title>Board update</title><script src="app.js"></script>'));
        sandbox.writeFile('deck/app.js', 'console.log(1)');
        // Binary assets in a subfolder travel with the page.
        for (const n of [1, 2, 3]) sandbox.writeFile(`deck/cards/${n}.png`, PNG);
        const out = JSON.parse(ok(await run(['artifacts', 'publish', 'deck', '--json']), 'publish').stdout);
        if (out.title !== 'Board update' || out.type !== 'html' || !out.path.endsWith('/Artifacts/board-update') || out.created_by_session_id !== sessionId) throw new Error(JSON.stringify(out));
        page = out.artifact_id;
        for (const n of [1, 2, 3]) {
          const img = await fetch(`${out.view_url}cards/${n}.png`);
          const bytes = Buffer.from(await img.arrayBuffer());
          if (img.status !== 200 || img.headers.get('content-type') !== 'image/png' || !bytes.equals(PNG)) throw new Error(`cards/${n}.png ${img.status} ${bytes.length}`);
        }
      });

      await ctx.step('`publish report.md` makes a doc: a folder in Files with index.md, titled by its heading', async () => {
        sandbox.writeFile('report.md', '# Churn report\n\nChurn fell to **2.1%**.\n');
        const out = JSON.parse(ok(await run(['artifacts', 'publish', 'report.md', '--json']), 'publish md').stdout);
        if (out.type !== 'doc' || out.title !== 'Churn report' || !out.path.endsWith('/Artifacts/churn-report')) throw new Error(JSON.stringify(out));
        doc = out.artifact_id;
        docPath = out.path;
      });

      await ctx.step('`pull` + edit + `publish --id --base-version` saves; the same save again exits 3; `cat` and `versions` show the new state', async () => {
        const pulled = JSON.parse(ok(await run(['artifacts', 'pull', doc, 'work', '--json']), 'pull').stdout);
        const md = sandbox.readFile('work/index.md');
        sandbox.writeFile('work/index.md', md.replace('2.1%', '1.9%'));
        ok(await run(['artifacts', 'publish', 'work', '--id', doc, '--base-version', pulled.entry_version]), 'save');
        ok(await run(['artifacts', 'publish', 'work', '--id', doc, '--base-version', pulled.entry_version]), 'stale save', 3);
        if (!ok(await run(['artifacts', 'cat', doc]), 'cat').stdout.includes('1.9%')) throw new Error('cat shows the old doc');
        const versions = JSON.parse(ok(await run(['artifacts', 'versions', doc, '--json']), 'versions').stdout);
        if (versions.length !== 2) throw new Error(JSON.stringify(versions));
      });

      await ctx.step('`rm` stops sharing (the file stays); `add <path>` shares the same file again; `share --visibility project` → project', async () => {
        ok(await run(['artifacts', 'rm', doc]), 'rm');
        const again = JSON.parse(ok(await run(['artifacts', 'add', docPath, '--json']), 'add').stdout);
        if (again.type !== 'doc' || again.path !== docPath) throw new Error(JSON.stringify(again));
        const shared = JSON.parse(ok(await run(['artifacts', 'share', again.artifact_id, '--visibility', 'project', '--json']), 'share').stdout);
        if (shared.visibility !== 'project') throw new Error(JSON.stringify(shared));
        ok(await run(['artifacts', 'rm', again.artifact_id]), 'rm again');
        ok(await run(['artifacts', 'rm', page]), 'rm page');
      });
    } finally {
      await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', { params: { projectId: project.id, tokenId: minted.token_id } }).catch(() => {});
    }
  },
);
