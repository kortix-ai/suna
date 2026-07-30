import {
  getMaintenanceConfig,
  setMaintenanceConfig,
  type MaintenanceConfig,
  type MaintenanceLevel,
} from '@/lib/maintenance-store';
import { createClient } from '@/lib/supabase/server';
import { getUserRolesWithToken } from '@kortix/sdk';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// GET /api/maintenance — public, returns current maintenance config
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const config = await getMaintenanceConfig();
    return NextResponse.json(config, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    console.error('[api/maintenance] GET error:', err);
    return NextResponse.json(
      {
        level: 'blocking',
        title: 'Service maintenance',
        message: 'Kortix is temporarily unavailable. Service will resume automatically.',
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

  // Merge with current config so partial updates work
  const current = await getMaintenanceConfig();
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
