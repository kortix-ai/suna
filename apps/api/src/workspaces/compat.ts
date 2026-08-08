import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types';

const WORKSPACE_KEYS: Readonly<Record<string, string>> = {
  project_id: 'workspace_id',
  project_role: 'workspace_role',
  effective_project_role: 'effective_workspace_role',
  project: 'workspace',
  projects: 'workspaces',
};

export function toWorkspacePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWorkspacePayload);
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const workspaceKey = WORKSPACE_KEYS[key] ?? key;
    if (workspaceKey !== key && Object.hasOwn(source, workspaceKey)) continue;
    target[workspaceKey] = toWorkspacePayload(child);
  }
  return target;
}

export const workspaceResponseCompatibility: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  if (c.req.method === 'HEAD') return;
  const response = c.res;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('+json')) return;

  const body = await response.clone().text();
  if (!body) return;

  const payload = JSON.parse(body) as unknown;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  c.res = new Response(JSON.stringify(toWorkspacePayload(payload)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
