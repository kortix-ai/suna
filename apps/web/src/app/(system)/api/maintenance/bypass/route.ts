import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  MAINTENANCE_BYPASS_COOKIE,
  MAINTENANCE_BYPASS_TTL_SECONDS,
  createBypassToken,
} from '@/lib/maintenance-bypass';

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

  const isAdmin = await checkAdminRole();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 });
  }

  const token = await createBypassToken();
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

/**
 * Check the caller's platform admin role via the backend `/user-roles`
 * endpoint, mirroring `PUT /api/maintenance` and the client `useAdminRole` hook.
 */
async function checkAdminRole(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return false;

    const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '';

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
