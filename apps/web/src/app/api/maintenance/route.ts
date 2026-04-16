import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  getMaintenanceConfig,
  setMaintenanceConfig,
  type MaintenanceConfig,
  type MaintenanceLevel,
} from '@/lib/maintenance-store';

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
      { level: 'none', title: '', message: '', updatedAt: new Date().toISOString() },
      { status: 200 },
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/maintenance — admin only, updates maintenance config
// ---------------------------------------------------------------------------

const VALID_LEVELS: MaintenanceLevel[] = ['none', 'info', 'warning', 'critical', 'blocking'];

export async function PUT(request: NextRequest) {
  // Authenticate: require a valid Supabase session
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role via the backend API
  const isAdmin = await checkAdminRole(request);
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
    affectedServices: body.affectedServices !== undefined ? body.affectedServices : current.affectedServices,
    updatedAt: new Date().toISOString(),
  };

  try {
    await setMaintenanceConfig(updated);
    return NextResponse.json(updated);
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
async function checkAdminRole(request: NextRequest): Promise<boolean> {
  try {
    // Forward the authorization header from the original request if present,
    // otherwise extract the Supabase access token from the cookie.
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session?.access_token) return false;

    const backendUrl =
      process.env.BACKEND_URL ||
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      '';

    const res = await fetch(`${backendUrl}/user-roles`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) return false;

    const data: { isAdmin?: boolean } = await res.json();
    return data.isAdmin === true;
  } catch {
    return false;
  }
}
