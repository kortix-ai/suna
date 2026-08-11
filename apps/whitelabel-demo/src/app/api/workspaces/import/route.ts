/**
 * List the account's workspaces, and import one into this demo user.
 *
 * Gated on `LUMEN_ALLOW_WORKSPACE_IMPORT` — see server/workspace-adoption.ts for why
 * this is a deployment switch rather than a per-user permission, and why a real
 * product would not expose it at all.
 *
 * Calls upstream DIRECTLY rather than through `/api/kortix`, because the point is
 * to see workspaces the proxy's ownership filter deliberately hides. That is the
 * whole reason this route is gated: it is the ONE place the tenancy filter is
 * bypassed, so the gate lives here where it is visible, not scattered.
 */

import { getRequestSession } from '@/server/auth';
import {
  WORKSPACE_IMPORT_ENV_VAR,
  workspaceImportEnabled,
  selectImportableWorkspaces,
} from '@/server/workspace-adoption';
import { addOwnedWorkspace, isValidWorkspaceId, listOwnedWorkspaces } from '@/server/users';
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
      error: `Workspace import is off. Set ${WORKSPACE_IMPORT_ENV_VAR}=1 to enable it on this deployment.`,
      envVar: WORKSPACE_IMPORT_ENV_VAR,
    },
    { status: 403 },
  );
}

export async function GET(req: NextRequest) {
  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!workspaceImportEnabled()) return disabled();

  const key = process.env.KORTIX_API_KEY;
  if (!key) {
    return Response.json({ error: 'Wrapper mode is not enabled on this server.' }, { status: 500 });
  }

  // The SDK's server transport, not a raw fetch — the boundary lint enforces
  // this so every server-side Kortix call goes through one audited path.
  const kortix = createScopedKortix({ backendUrl: upstreamBase(), getToken: async () => key });
  let rows: unknown[];
  try {
    const body = (await kortix.workspaces.list()) as unknown;
    rows = Array.isArray(body) ? body : [];
  } catch {
    return Response.json({ error: 'Could not read the account’s workspaces.' }, { status: 502 });
  }
  return Response.json({
    workspaces: selectImportableWorkspaces(rows as never, listOwnedWorkspaces(session.userId)),
  });
}

export async function POST(req: NextRequest) {
  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!workspaceImportEnabled()) return disabled();

  const body = (await req.json().catch(() => null)) as { workspace_id?: unknown } | null;
  const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id : '';
  // Validated before it is stored: ids from this store end up inside upstream
  // request URLs, so a malformed one must never be able to steer a request.
  if (!isValidWorkspaceId(workspaceId)) {
    return Response.json({ error: 'A valid workspace id is required.' }, { status: 400 });
  }

  addOwnedWorkspace(session.userId, workspaceId);
  return Response.json({ ok: true, workspace_id: workspaceId });
}
