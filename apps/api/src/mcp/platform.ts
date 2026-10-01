import { ToolInputError, apiResult, arg, callApi, loadCatalog, limitArg, optionalArg, projectArg, resolveRefs, text, type ToolContext, type ToolResult } from './common';
import { requestBodyShape, searchOperations } from './shape';

async function toolReadSkill(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const name = optionalArg(input, 'name');
  if (!name) {
    const r = await callApi(ctx, 'GET', '/v1/skills');
    if (r.status >= 400) return apiResult(r);
    const skills = JSON.parse(r.body).skills as { name: string; description: string }[];
    return text(skills.map((s) => `${s.name} — ${s.description}`).join('\n\n'));
  }
  const file = optionalArg(input, 'file');
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

async function toolSearchApi(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const { ops } = await loadCatalog(ctx);
  const hits = searchOperations(ops, arg(input, 'query'), limitArg(input, 'limit', 20, 100));
  if (hits.length === 0) return text('No matching routes. Try broader keywords.');
  return text(hits.map((op) => `${op.method} ${op.path}${op.summary && !op.summary.startsWith(op.method) ? ` — ${op.summary}` : ''}`).join('\n'));
}

async function toolDescribeApi(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
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

async function toolCallApi(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
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

export async function dispatchPlatform(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult | undefined> {
  switch (name) {
    case 'read_skill': return toolReadSkill(ctx, input);
    case 'search_api': return toolSearchApi(ctx, input);
    case 'describe_api': return toolDescribeApi(ctx, input);
    case 'call_api': return toolCallApi(ctx, input);
    default: return undefined;
  }
}
