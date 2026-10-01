import { parseArgs, runCli } from './cli';
import { isUuid } from '../shared/validate';
import { projectSkills, ToolInputError, apiResult, arg, callApi, loadCatalog, limitArg, optionalArg, projectArg, resolveRefs, text, type ToolContext, type ToolResult } from './common';
import { requestBodyShape, searchOperations } from './shape';

export async function dispatchPlatform(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult | undefined> {
  switch (name) {
    case 'read_skill': {
      const name = optionalArg(input, 'name');
      const file = optionalArg(input, 'file');
      const projectId = optionalArg(input, 'project_id');
      const own = projectId ? await projectSkills(ctx, projectArg(input)) : [];
      if (own instanceof Error) throw own;
      const mine = name ? own.find((s) => s.slug === name || s.name === name) : undefined;
      if (mine) {
        const dir = mine.path.slice(0, mine.path.lastIndexOf('/') + 1);
        if (file) {
          if (file.split('/').includes('..')) throw new ToolInputError('file must stay inside the skill directory');
          const r = await callApi(ctx, 'GET', `/v1/projects/${projectId}/files/content`, { query: { path: `${dir}${file.replace(/^\/+/, '')}` } });
          return r.status >= 400 ? apiResult(r) : text(JSON.parse(r.body).content);
        }
        const r = await callApi(ctx, 'GET', `/v1/projects/${projectId}/files/content`, { query: { path: mine.path } });
        if (r.status >= 400) return apiResult(r);
        const refs = mine.files.filter((f) => f !== mine.path).map((f) => `- ${f.slice(dir.length)}`);
        const body = JSON.parse(r.body).content as string;
        return text(refs.length ? `${body}\n\nReference files (read_skill with project_id, name and file):\n${refs.join('\n')}` : body);
      }
      if (!name) {
        const r = await callApi(ctx, 'GET', '/v1/skills');
        if (r.status >= 400) return apiResult(r);
        const skills = JSON.parse(r.body).skills as { name: string; description: string }[];
        const guides = skills.map((s) => `${s.name} — ${s.description}`).join('\n\n');
        if (!projectId) return text(guides);
        const project = own.map((s) => `${s.slug} — ${s.description ?? '(no description)'}`).join('\n\n');
        return text(`Project skills (read_skill with project_id and name):\n\n${project || '(none: the project has no skills/ directory)'}\n\nPlatform guides:\n\n${guides}`);
      }
      if (file) {
        const r = await callApi(ctx, 'GET', `/v1/skills/${encodeURIComponent(name)}/file`, { query: { path: file } });
        return r.status >= 400 ? apiResult(r) : text(JSON.parse(r.body).content);
      }
      // The body and its reference paths, as `kortix system-skills get` prints
      // them: every reference inline (`?full=1`) is ~280 KB for kortix-system.
      const r = await callApi(ctx, 'GET', `/v1/skills/${encodeURIComponent(name)}`);
      if (r.status >= 400) return apiResult(r);
      const skill = JSON.parse(r.body) as { body: string; references?: { path: string }[] };
      const refs = (skill.references ?? []).map((f) => `- ${f.path}`);
      return text(refs.length ? `${skill.body}\n\nReference files (read_skill with file):\n${refs.join('\n')}` : skill.body);
    }
    case 'kortix': {
      const args = parseArgs(input.args);
      if (typeof args === 'string') throw new ToolInputError(args);
      const projectId = optionalArg(input, 'project_id');
      const sessionId = optionalArg(input, 'session_id');
      if ((projectId && !isUuid(projectId)) || (sessionId && !isUuid(sessionId))) throw new ToolInputError('project_id and session_id must be UUIDs (list_projects, list_sessions)');
      const timeoutMs = Math.min(45_000, ctx.deadline - Date.now() - 4_000);
      if (timeoutMs < 2_000) throw new ToolInputError('Not enough time left in this MCP request for a command. Call again.');
      const run = await runCli({
        args,
        // The caller's own credential, as sent: the CLI then acts as exactly this user through this API.
        token: ctx.authorization.replace(/^Bearer\s+/i, ''),
        apiUrl: `http://127.0.0.1:${Number(process.env.PORT) || 8008}/v1`,
        projectId,
        sessionId,
        timeoutMs,
      });
      return run.ok ? text(run.json, run.exitCode !== 0) : text(run.error, true);
    }
    case 'search_api': {
      const { ops } = await loadCatalog(ctx);
      const hits = searchOperations(ops, arg(input, 'query'), limitArg(input, 'limit', 20, 100));
      if (hits.length === 0) return text('No matching routes. Try broader keywords.');
      return text(hits.map((op) => `${op.method} ${op.path}${op.summary && !op.summary.startsWith(op.method) ? ` — ${op.summary}` : ''}`).join('\n'));
    }
    case 'describe_api': {
      const { ops, doc } = await loadCatalog(ctx);
      const method = arg(input, 'method').toUpperCase();
      const path = arg(input, 'path').replace(/:([A-Za-z_]+)/g, '{$1}');
      const op = ops.find((o) => o.method === method && o.path === path);
      if (!op) return text(`No route ${method} ${path}. Use search_api to find it.`, true);
      const responses = op.spec.responses ?? {};
      const success = responses['200'] ?? responses['201'] ?? responses['202'];
      return text(
        JSON.stringify(
          resolveRefs(
            {
              method,
              path,
              summary: op.summary,
              description: op.description || undefined,
              parameters: op.spec.parameters,
              requestBody: requestBodyShape(resolveRefs(op.spec.requestBody, doc)),
              response: success?.content?.['application/json']?.schema,
            },
            doc,
          ),
          null,
          2,
        ),
      );
    }
    case 'call_api': {
      const method = arg(input, 'method').toUpperCase();
      let path = arg(input, 'path');
      if (/\{projectId\}|:projectId/.test(path)) {
        const projectId = projectArg(input);
        path = path.replaceAll('{projectId}', projectId).replaceAll(':projectId', projectId);
      }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ToolInputError(`method ${method} is not allowed`);
      if (!path.startsWith('/v1/')) throw new ToolInputError('path must start with /v1/ and not target /v1/oauth or an MCP endpoint');
      const open = /\{[^}/]+\}/.exec(path.split('?')[0]!)?.[0];
      if (open) throw new ToolInputError(`path still has ${open}: replace it with the real value, e.g. /v1/projects/{projectId}/secrets/MY_KEY`);
      const query = input.query && typeof input.query === 'object' ? (input.query as Record<string, unknown>) : undefined;
      let body = input.body;
      // A client that types `body` as a string sends JSON text: parse it, never double-encode it.
      if (typeof body === 'string') body = (() => { try { return JSON.parse(body as string); } catch { return body; } })();
      return apiResult(await callApi(ctx, method, path, { query, body, summarizeBinary: true }), `${method} ${path}`);
    }
    default: return undefined;
  }
}
