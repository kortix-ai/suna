import { MAINTENANCE_PUBLIC_CACHE_CONTROL } from '@/lib/maintenance-client';
import {
  getMaintenanceConfig,
  readDatabaseMaintenanceConfig,
  reconcileMaintenanceEdgeConfig,
  setMaintenanceConfig,
  type MaintenanceConfig,
  type MaintenanceLevel,
} from '@/lib/maintenance-store';
import { createClient } from '@/lib/supabase/server';
import { getUserRolesWithToken } from '@kortix/sdk';
import { after, NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// GET /api/maintenance — public, returns current maintenance config
// ---------------------------------------------------------------------------
//
// Every open tab polls this (MaintenanceBannerHost, root layout, every 60 s and
// on focus — marketing pages included, on purpose: a system notice must reach
// visitors too). It reads only this environment's Edge Config key and answers
// with a short shared cache, so a fleet of tabs costs one origin hit per
// ~10 s per edge region. The database → Edge Config reconcile runs after the
// response (`after`), throttled per instance, never in the request.

export async function GET() {
  after(() => reconcileMaintenanceEdgeConfig());
  try {
    const config = await getMaintenanceConfig();
    return NextResponse.json(config, {
      headers: { 'Cache-Control': MAINTENANCE_PUBLIC_CACHE_CONTROL },
    });
  } catch (err) {
    console.error('[api/maintenance] GET error:', err);
    // Fail open: a transient error reading the maintenance config should
    // not trigger a blocking lockdown. Return normal operation.
    return NextResponse.json(
      {
        level: 'none',
        title: '',
        message: '',
        updatedAt: new Date().toISOString(),
      },
      { status: 200 },
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/maintenance — admin only, updates maintenance config
// ---------------------------------------------------------------------------

const VALID_LEVELS: MaintenanceLevel[] = ['none', 'info', 'warning', 'critical', 'blocking'];

export async function PUT(request: NextRequest) {
  const bearerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
  let accessToken = bearerToken;

  if (!accessToken) {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();
    accessToken = session?.access_token ?? null;
  }

  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await checkAdminRole(accessToken);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 });
  }

  // Parse and validate body
  let body: Partial<MaintenanceConfig>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.level && !VALID_LEVELS.includes(body.level)) {
    return NextResponse.json(
      { error: `Invalid level. Must be one of: ${VALID_LEVELS.join(', ')}` },
      { status: 400 },
    );
  }

  // Merge with the database state (the source of truth) so partial updates
  // work; fall back to the Edge Config state if the API cannot be read.
  const current = await readDatabaseMaintenanceConfig().catch(() => getMaintenanceConfig());
  const updated: MaintenanceConfig = {
    level: body.level ?? current.level,
    title: body.title ?? current.title,
    message: body.message ?? current.message,
    startTime: body.startTime !== undefined ? body.startTime : current.startTime,
    endTime: body.endTime !== undefined ? body.endTime : current.endTime,
    statusUrl: body.statusUrl !== undefined ? body.statusUrl : current.statusUrl,
    affectedServices:
      body.affectedServices !== undefined ? body.affectedServices : current.affectedServices,
    updatedAt: new Date().toISOString(),
  };

  try {
    const saved = await setMaintenanceConfig(updated, accessToken);
    return NextResponse.json(saved);
  } catch (err) {
    console.error('[api/maintenance] PUT error:', err);
    return NextResponse.json({ error: 'Failed to update maintenance config' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check admin role by forwarding the user's auth cookies to the backend
 * /user-roles endpoint, matching the client-side useAdminRole hook logic.
 */
async function checkAdminRole(accessToken: string): Promise<boolean> {
  try {
    const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '';

    const data = await getUserRolesWithToken<{ isAdmin?: boolean }>({
      backendUrl,
      accessToken,
    });
    return data.isAdmin === true;
  } catch {
    return false;
  }
}
