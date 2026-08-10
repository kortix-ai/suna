/**
 * List the account's projects, and import one into this demo user.
 *
 * Gated on `LUMEN_ALLOW_PROJECT_IMPORT` — see server/project-adoption.ts for why
 * this is a deployment switch rather than a per-user permission, and why a real
 * product would not expose it at all.
 *
 * Calls upstream DIRECTLY rather than through `/api/kortix`, because the point is
 * to see projects the proxy's ownership filter deliberately hides. That is the
 * whole reason this route is gated: it is the ONE place the tenancy filter is
 * bypassed, so the gate lives here where it is visible, not scattered.
 */

import { getRequestSession } from '@/server/auth';
import {
  PROJECT_IMPORT_ENV_VAR,
  projectImportEnabled,
  selectImportableProjects,
} from '@/server/project-adoption';
import { addOwnedProject, isValidProjectId, listOwnedProjects } from '@/server/users';
import { createScopedKortix } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(/\/+$/, '');
}

function disabled() {
  return Response.json(
    {
      error: `Project import is off. Set ${PROJECT_IMPORT_ENV_VAR}=1 to enable it on this deployment.`,
      envVar: PROJECT_IMPORT_ENV_VAR,
    },
    { status: 403 },
  );
}

export async function GET(req: NextRequest) {
  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!projectImportEnabled()) return disabled();

  const key = process.env.KORTIX_API_KEY;
  if (!key) {
    return Response.json({ error: 'Wrapper mode is not enabled on this server.' }, { status: 500 });
  }

  // The SDK's server transport, not a raw fetch — the boundary lint enforces
  // this so every server-side Kortix call goes through one audited path.
  const kortix = createScopedKortix({ backendUrl: upstreamBase(), getToken: async () => key });
  let rows: unknown[];
  try {
    const body = (await kortix.projects.list()) as unknown;
    rows = Array.isArray(body) ? body : [];
  } catch {
    return Response.json({ error: 'Could not read the account’s projects.' }, { status: 502 });
  }
  return Response.json({
    projects: selectImportableProjects(rows as never, listOwnedProjects(session.userId)),
  });
}

export async function POST(req: NextRequest) {
  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!projectImportEnabled()) return disabled();

  const body = (await req.json().catch(() => null)) as { project_id?: unknown } | null;
  const workspaceId = typeof body?.project_id === 'string' ? body.project_id : '';
  // Validated before it is stored: ids from this store end up inside upstream
  // request URLs, so a malformed one must never be able to steer a request.
  if (!isValidProjectId(workspaceId)) {
    return Response.json({ error: 'A valid project id is required.' }, { status: 400 });
  }

  addOwnedProject(session.userId, workspaceId);
  return Response.json({ ok: true, project_id: workspaceId });
}
