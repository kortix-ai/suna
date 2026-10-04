import { isAdminAccessToken } from '@/lib/admin-role';
import {
  MAINTENANCE_BYPASS_COOKIE,
  MAINTENANCE_BYPASS_TTL_SECONDS,
  createBypassToken,
} from '@/lib/maintenance-bypass';
import { createClient } from '@/lib/supabase/server';
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// POST /api/maintenance/bypass — admin only. Mints a signed, httpOnly bypass
// cookie so a platform admin keeps access during Full Lockdown. Middleware
// verifies the cookie and lets these requests through the maintenance redirect.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // The session token is read inline above; only the role check is shared.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const isAdmin = session?.access_token ? await isAdminAccessToken(session.access_token) : false;
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 });
  }

  const token = await createBypassToken(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MAINTENANCE_BYPASS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAINTENANCE_BYPASS_TTL_SECONDS,
  });
  return res;
}

// ---------------------------------------------------------------------------
// DELETE /api/maintenance/bypass — clear the bypass cookie (re-lock yourself).
// Any authenticated user may clear their own cookie.
// ---------------------------------------------------------------------------

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MAINTENANCE_BYPASS_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
