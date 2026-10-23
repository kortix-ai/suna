/**
 * ART-1..2 — Artifacts: HTML pages people and agents publish in a project
 * (flag `artifacts`). Contract: tests/spec/end-to-end.md §36. The bytes live
 * on the project's artifact volume (Platinum); on a target without volume
 * storage the flag stays off and ART-1 asserts that instead.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { CliSandbox, type CliResult } from '../fixtures/cli';
import { bindDatabaseSessionCredential, createDatabaseSession } from '../fixtures/database-project';

const LIST = '/v1/projects/:projectId/artifacts';
const TYPES = '/v1/projects/:projectId/artifacts/types';
const ONE = '/v1/projects/:projectId/artifacts/:artifactId';
const PIN = '/v1/projects/:projectId/artifacts/:artifactId/pin';
const VERSIONS = '/v1/projects/:projectId/artifacts/:artifactId/versions';
const RESTORE = '/v1/projects/:projectId/artifacts/:artifactId/restore';
const CONTENT = '/v1/projects/:projectId/artifacts/:artifactId/content';

type Detail = {
  artifact_id: string; title: string; type: string; visibility: string; current_version: number; can_edit: boolean; pinned: boolean;
  view_url: string; public_url: string | null; public_content_url: string | null; shared_with_user_ids: string[];
  version: { version: number; files: { path: string }[] };
};

const PAGE_V1 = '<!doctype html><html><head><title>Churn report</title><link rel="stylesheet" href="style.css"></head><body><h1>Churn report</h1><p>v1 body</p></body></html>';
const PAGE_V2 = PAGE_V1.replace('v1 body', 'v2 body');

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
      `GET ${TYPES}`, `GET ${LIST}`, `POST ${LIST}`, `GET ${ONE}`, `PUT ${ONE}`, `PATCH ${ONE}`, `DELETE ${ONE}`,
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
    let id = '';
    const one = () => ({ params: { projectId: project.id, artifactId: id } });

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

    await ctx.step('GET types → doc and html, each with a format and a starter page', async () => {
      const types = (await owner.get(TYPES, { params: p })).status(200).json<{ types: { type: string; starter: string; format: string }[] }>().types;
      if (types.map((t) => t.type).sort().join() !== 'doc,html') throw new Error(JSON.stringify(types.map((t) => t.type)));
      if (types.some((t) => !t.starter.includes('<html') || !t.format)) throw new Error('a type lacks its starter or format');
    });

    await ctx.step('a publish without index.html → 400 missing_entry; a path with .. → 400 invalid_path', async () => {
      (await owner.post(LIST, { files: { 'a.css': { content: 'x' } } }, { params: p })).status(400).body().has('$.code', 'missing_entry');
      (await owner.post(LIST, { files: { 'index.html': { content: 'x' }, '../x': { content: 'x' } } }, { params: p })).status(400).body().has('$.code', 'invalid_path');
    });

    let storage = true;
    await ctx.step('OWNER publishes a doc (index.html + style.css) → 201, version 1, private, title from <title> (503 without volume storage)', async () => {
      const r = await owner.post(LIST, {
        type: 'doc',
        files: { 'index.html': { content: PAGE_V1 }, 'style.css': { content: 'p{color:red}' } },
      }, { params: p });
      if (r.statusCode === 503) {
        r.body().has('$.code', 'drive_storage_unavailable');
        storage = false;
        return;
      }
      const a = r.status(201).json<Detail>();
      if (a.title !== 'Churn report' || a.type !== 'doc' || a.visibility !== 'private' || a.current_version !== 1 || !a.can_edit) throw new Error(JSON.stringify(a));
      if (a.version.files.map((f) => f.path).join() !== 'index.html,style.css') throw new Error(JSON.stringify(a.version.files));
      if (a.public_url || a.public_content_url) throw new Error('a private artifact has a public link');
      id = a.artifact_id;
    });

    if (!storage) return;

    await ctx.step('the signed view_url serves the page with the doc stylesheet, as a CSP sandbox; style.css resolves; an unknown path → 404', async () => {
      const a = (await owner.get(ONE, one())).status(200).json<Detail>();
      const page = await get(a.view_url);
      if (page.status !== 200 || !page.headers.get('content-type')?.startsWith('text/html')) throw new Error(`view ${page.status} ${page.headers.get('content-type')}`);
      if (!/sandbox allow-scripts/.test(page.headers.get('content-security-policy') ?? '') || /allow-same-origin/.test(page.headers.get('content-security-policy') ?? '')) {
        throw new Error(`CSP ${page.headers.get('content-security-policy')}`);
      }
      if (!page.text.includes('v1 body') || !page.text.includes('class="kx-doc"')) throw new Error('page lacks its body or the doc stylesheet');
      if (!(await get(`${a.view_url}?print=1`)).text.includes('print()')) throw new Error('?print=1 does not open the print dialog');
      const css = await get(`${a.view_url}style.css`);
      if (css.status !== 200 || css.text !== 'p{color:red}' || !css.headers.get('content-type')?.startsWith('text/css')) throw new Error(`css ${css.status}`);
      if ((await get(`${a.view_url}nope.js`)).status !== 404) throw new Error('unknown path served');
      const bare = await get(a.view_url.replace(/\/$/, ''));
      if (bare.status !== 301 || !bare.headers.get('location')?.endsWith('/')) throw new Error(`bare view URL ${bare.status}`);
      if ((await get(a.view_url.replace(/\/s\/[^.]+/, '/s/forged'))).status !== 404) throw new Error('a forged token served');
    });

    await ctx.step('a private artifact is invisible to a project member: list leaves it out, GET → 404', async () => {
      // Each API process caches membership up to 15 s: wait until the new member is let in.
      const deadline = Date.now() + 45_000;
      while ((await asMember.get(LIST, { params: p })).statusCode !== 200) {
        if (Date.now() > deadline) throw new Error('the new member never reached the artifact list');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const list = (await asMember.get(LIST, { params: p })).status(200).json<{ artifacts: Detail[] }>().artifacts;
      if (list.some((x) => x.artifact_id === id)) throw new Error('member lists a private artifact');
      (await asMember.get(ONE, one())).status(404);
      (await ctx.client.as(ctx.P.NONMEMBER).get(ONE, one())).status([403, 404]);
    });

    await ctx.step('OWNER shares it with the member: they read it (can_edit false) but cannot publish → 403 artifact_read_only', async () => {
      (await owner.patch(ONE, { shared_with_user_ids: [member.userId] }, one())).status(200);
      const a = (await asMember.get(ONE, one())).status(200).json<Detail>();
      if (a.can_edit) throw new Error('a viewer can edit');
      (await asMember.put(ONE, { files: { 'index.html': { content: 'x' } } }, one())).status(403).body().has('$.code', 'artifact_read_only');
    });

    await ctx.step('visibility project: every member lists it', async () => {
      (await owner.patch(ONE, { visibility: 'project', shared_with_user_ids: [] }, one())).status(200);
      const list = (await asMember.get(LIST, { params: p })).status(200).json<{ artifacts: Detail[] }>().artifacts;
      if (!list.some((x) => x.artifact_id === id)) throw new Error('member does not list a project artifact');
    });

    await ctx.step('PUT version 2 from base 1 keeps style.css; a second PUT from base 1 → 409 version_conflict', async () => {
      const a = (await owner.put(ONE, { base_version: 1, label: 'second', files: { 'index.html': { content: PAGE_V2 } } }, one())).status(200).json<Detail>();
      if (a.current_version !== 2 || !a.version.files.some((f) => f.path === 'style.css')) throw new Error(JSON.stringify(a.version));
      (await owner.put(ONE, { base_version: 1, files: { 'index.html': { content: 'x' } } }, one())).status(409).body().has('$.code', 'version_conflict');
      const amended = (await owner.put(ONE, { base_version: 2, amend: true, files: { 'index.html': { content: PAGE_V2.replace('v2 body', 'v2 body amended') } } }, one())).status(200).json<Detail>();
      if (amended.current_version !== 2) throw new Error(`an autosave within 10 min made version ${amended.current_version}`);
    });

    await ctx.step('content: the current source, and version 1 by number; the source carries no kit', async () => {
      const now = (await owner.get(CONTENT, { ...one(), query: { path: 'index.html' } })).status(200).text();
      const old = (await owner.get(CONTENT, { ...one(), query: { version: '1' } })).status(200).text();
      if (!now.includes('v2 body amended') || !old.includes('v1 body') || now.includes('kx-doc')) throw new Error('wrong source');
    });

    await ctx.step('a doc published as Markdown is stored as its HTML page: title from `# `, GFM table and task list', async () => {
      const md = '# Plan\n\n- [x] ship\n- [ ] announce\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
      const a = (await owner.post(LIST, { type: 'doc', files: { 'index.md': { content: md } } }, { params: p })).status(201).json<Detail>();
      if (a.title !== 'Plan' || a.version.files.map((f) => f.path).join() !== 'index.html') throw new Error(JSON.stringify(a));
      const html = (await owner.get(CONTENT, { params: { projectId: project.id, artifactId: a.artifact_id } })).status(200).text();
      if (!html.includes('<table>') || !html.includes('data-type="taskList"') || !html.includes('data-checked="true"')) throw new Error(html.slice(0, 400));
      (await owner.del(ONE, { params: { projectId: project.id, artifactId: a.artifact_id } })).status(200);
    });

    await ctx.step('versions lists 2, 1; restoring 1 makes version 3 with the v1 page', async () => {
      const v = (await owner.get(VERSIONS, one())).status(200).json<{ versions: { version: number }[] }>().versions.map((x) => x.version);
      if (v.join() !== '2,1') throw new Error(v.join());
      const a = (await owner.post(RESTORE, { version: 1 }, one())).status(200).json<Detail>();
      if (a.current_version !== 3) throw new Error(String(a.current_version));
      const page = await get(a.view_url);
      if (!page.text.includes('v1 body')) throw new Error('restore did not bring v1 back');
    });

    await ctx.step('pin is personal: pinned for OWNER, listed under scope=pinned, not pinned for the member', async () => {
      (await owner.put(PIN, undefined, one())).status(200).body().has('$.pinned', true);
      const pinned = (await owner.get(LIST, { params: p, query: { scope: 'pinned' } })).status(200).json<{ artifacts: Detail[] }>().artifacts;
      if (pinned.map((x) => x.artifact_id).join() !== id) throw new Error('pinned scope');
      (await asMember.get(ONE, one())).status(200).body().has('$.pinned', false);
      (await owner.del(PIN, one())).status(200).body().has('$.pinned', false);
    });

    await ctx.step('public: the raw page serves without a login; back to private → 404 at once', async () => {
      const a = (await owner.patch(ONE, { visibility: 'public' }, one())).status(200).json<Detail>();
      if (!a.public_url?.includes(`/share/artifact/${id}`) || !a.public_content_url) throw new Error(JSON.stringify(a));
      const page = await get(a.public_content_url);
      if (page.status !== 200 || !page.text.includes('Churn report')) throw new Error(`public ${page.status}`);
      const bare = await get(a.public_content_url.replace(/\/$/, ''));
      if (bare.status !== 301 || !bare.headers.get('location')?.endsWith(`/p/${id}/`)) throw new Error(`bare public URL ${bare.status}`);
      const meta = await get(`${ctx.env.apiUrl}/artifacts/meta/${id}`);
      if (meta.status !== 200 || JSON.parse(meta.text).title !== 'Churn report') throw new Error(`meta ${meta.status}`);
      (await owner.patch(ONE, { visibility: 'private' }, one())).status(200);
      if ((await get(a.public_content_url)).status !== 404) throw new Error('revoked public link still serves');
      if ((await get(`${ctx.env.apiUrl}/artifacts/meta/${id}`)).status !== 404) throw new Error('revoked meta still answers');
    });

    await ctx.step('the member cannot delete it (403); OWNER deletes it → GET 404, the signed URL → 404', async () => {
      (await owner.patch(ONE, { visibility: 'project' }, one())).status(200);
      const viewUrl = (await owner.get(ONE, one())).status(200).json<Detail>().view_url;
      (await asMember.del(ONE, one())).status(403);
      (await owner.del(ONE, one())).status(200);
      (await owner.get(ONE, one())).status(404);
      if ((await get(viewUrl)).status !== 404) throw new Error('a deleted artifact still serves');
    });
  },
);

flow(
  'ART-2',
  {
    domain: 'artifacts',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: ['POST /v1/projects/:projectId/cli-token', `GET ${LIST}`, `POST ${LIST}`, `PUT ${ONE}`, `PATCH ${ONE}`, `GET ${ONE}`, `GET ${CONTENT}`, `DELETE ${ONE}`],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    if (!(await enableArtifacts(ctx, project.id))) {
      await ctx.step('no volume storage on this target: nothing to publish', async () => {});
      return;
    }
    const probe = await ctx.client.as(ctx.P.OWNER).post(LIST, { files: { 'index.html': { content: '<p>probe</p>' } } }, { params: { projectId: project.id } });
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
    const dir = 'deck';
    let id = '';
    try {
      await ctx.step('`artifacts types html --starter` prints a page; the agent publishes a folder → html, version 1, recorded with its session', async () => {
        const starter = ok(await run(['artifacts', 'types', 'html', '--starter']), 'types').stdout;
        if (!starter.includes('<html')) throw new Error(starter.slice(0, 200));
        sandbox.writeFile('deck/index.html', starter.replace('<title>Untitled page</title>', '<title>Board update</title>'));
        const out = JSON.parse(ok(await run(['artifacts', 'publish', dir, '--json']), 'publish').stdout);
        if (out.title !== 'Board update' || out.type !== 'html' || out.current_version !== 1 || out.created_by_session_id !== sessionId) throw new Error(JSON.stringify(out));
        id = out.artifact_id;
      });

      await ctx.step('`publish report.md` makes a doc titled by its `# ` heading', async () => {
        sandbox.writeFile('report.md', '# Churn report\n\nChurn fell to **2.1%**.\n');
        const out = JSON.parse(ok(await run(['artifacts', 'publish', 'report.md', '--json']), 'publish md').stdout);
        if (out.type !== 'doc' || out.title !== 'Churn report') throw new Error(JSON.stringify(out));
        ok(await run(['artifacts', 'rm', out.artifact_id]), 'rm doc');
      });

      await ctx.step('`ls` lists it; `pull` + edit + `publish --id --base-version 1` → version 2; a stale --base-version → exit 3', async () => {
        if (!ok(await run(['artifacts', 'ls']), 'ls').stdout.includes('Board update')) throw new Error('ls');
        ok(await run(['artifacts', 'pull', id.slice(0, 8), 'work']), 'pull');
        const page = sandbox.readFile('work/index.html');
        sandbox.writeFile('work/index.html', page.replace('Any HTML', 'Questions? Any HTML'));
        const out = JSON.parse(ok(await run(['artifacts', 'publish', 'work', '--id', id, '--base-version', '1', '--json']), 'republish').stdout);
        if (out.current_version !== 2) throw new Error(JSON.stringify(out));
        ok(await run(['artifacts', 'publish', 'work', '--id', id, '--base-version', '1']), 'stale publish', 3);
        if (!ok(await run(['artifacts', 'cat', id]), 'cat').stdout.includes('Questions?')) throw new Error('cat shows the old page');
      });

      await ctx.step('`share --visibility project` → project; `rm` → gone', async () => {
        const out = JSON.parse(ok(await run(['artifacts', 'share', id, '--visibility', 'project', '--json']), 'share').stdout);
        if (out.visibility !== 'project') throw new Error(JSON.stringify(out));
        ok(await run(['artifacts', 'rm', id]), 'rm');
        (await ctx.client.as(ctx.P.OWNER).get(ONE, { params: { projectId: project.id, artifactId: id } })).status(404);
      });
    } finally {
      await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', { params: { projectId: project.id, tokenId: minted.token_id } }).catch(() => {});
    }
  },
);
