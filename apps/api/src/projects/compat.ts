import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types';

const WORKSPACE_KEYS: Readonly<Record<string, string>> = {
  workspace_id: 'project_id',
  workspace_role: 'project_role',
  effective_workspace_role: 'effective_project_role',
  workspace: 'project',
  workspaces: 'projects',
  workspace_spend: 'project_spend',
  workspaceDefault: 'projectDefault',
};

const WORKSPACE_VALUE_KEYS = new Set([
  'authorization_strategy',
  'authorizationStrategy',
  'connectionOwnerType',
  'kind',
  'mode',
  'owner_type',
  'policy_source',
  'scope',
  'source',
  'visibility',
]);

const HUMAN_TEXT_KEYS = new Set(['error', 'message', 'title']);

function projectHumanText(value: string): string {
  return value
    .replaceAll('Workspaces', 'Projects')
    .replaceAll('workspaces', 'projects')
    .replaceAll('Workspace', 'Project')
    .replaceAll('workspace', 'project');
}

const PROJECT_REQUEST_KEYS: Readonly<Record<string, string>> = {
  project_id: 'workspace_id',
  project_role: 'workspace_role',
  effective_project_role: 'effective_workspace_role',
  project_name: 'workspace_name',
};

/** Translate the canonical Workspace response into the legacy Project wire shape. */
export function toProjectPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toProjectPayload);
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const projectKey = WORKSPACE_KEYS[key] ?? key;
    if (projectKey !== key && Object.hasOwn(source, projectKey)) continue;
    target[projectKey] =
      WORKSPACE_VALUE_KEYS.has(key) && child === 'workspace'
        ? 'project'
        : key === 'defaultModelSource' && child === 'workspace'
          ? 'project'
        : projectKey === 'dashboard_url' && typeof child === 'string'
          ? child.replace('/workspaces/', '/projects/')
        : projectKey === 'webhook_url' && typeof child === 'string'
          ? child.replace('/v1/webhooks/workspaces/', '/v1/webhooks/projects/')
        : projectKey === 'reason' && child === 'workspace provisioning backpressure'
          ? 'project provisioning backpressure'
        : HUMAN_TEXT_KEYS.has(projectKey) && typeof child === 'string'
          ? projectHumanText(child)
          : toProjectPayload(child);
  }
  return target;
}

/** Translate a legacy Project request at the namespace boundary. */
export function toWorkspaceRequestPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWorkspaceRequestPayload);
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const workspaceKey = PROJECT_REQUEST_KEYS[key] ?? key;
    target[workspaceKey] =
      WORKSPACE_VALUE_KEYS.has(key) && child === 'project'
        ? 'workspace'
        : toWorkspaceRequestPayload(child);
  }
  return target;
}

export const projectRequestCompatibility: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.raw.url);
  let queryChanged = false;
  for (const [key, child] of url.searchParams.entries()) {
    if (WORKSPACE_VALUE_KEYS.has(key) && child === 'project') {
      url.searchParams.set(key, 'workspace');
      queryChanged = true;
    }
  }
  if (queryChanged) {
    c.req.raw = new Request(url, c.req.raw);
    c.req.bodyCache = {};
  }

  const contentType = c.req.header('content-type') ?? '';
  if (
    c.req.method !== 'GET' &&
    c.req.method !== 'HEAD' &&
    contentType.includes('application/json')
  ) {
    const text = await c.req.raw.clone().text();
    if (text) {
      try {
        const headers = new Headers(c.req.raw.headers);
        headers.delete('content-length');
        c.req.raw = new Request(c.req.raw, {
          body: JSON.stringify(toWorkspaceRequestPayload(JSON.parse(text) as unknown)),
          headers,
        });
        c.req.bodyCache = {};
      } catch {
        // Preserve malformed JSON so the route's validator returns its normal 400.
      }
    }
  }
  await next();
};

function mapProjectSseFrame(frame: string): string {
  return frame
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) return line;
      const prefix = line.startsWith('data: ') ? 'data: ' : 'data:';
      const json = line.slice(prefix.length);
      if (!json) return line;
      try {
        return `${prefix}${JSON.stringify(toProjectPayload(JSON.parse(json) as unknown))}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function legacyProjectEventStream(response: Response): Response {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const stream = response.body.pipeThrough(
    // lgtm[js/superfluous-trailing-arguments] WHATWG TransformStream requires its transformer argument.
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          controller.enqueue(encoder.encode(`${mapProjectSseFrame(frame)}\n\n`));
          boundary = buffer.indexOf('\n\n');
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(mapProjectSseFrame(buffer)));
      },
    }),
  );
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const projectResponseCompatibility: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  if (c.req.method === 'HEAD') return;
  const response = c.res;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    c.res = legacyProjectEventStream(response);
    return;
  }
  if (!contentType.includes('application/json') && !contentType.includes('+json')) return;

  const body = await response.clone().text();
  if (!body) return;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  c.res = new Response(JSON.stringify(toProjectPayload(JSON.parse(body) as unknown)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
