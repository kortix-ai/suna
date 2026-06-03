/**
 * Setup routes — self-hosted instance management.
 *
 * Provides the public install probe and owner bootstrap endpoint used by the
 * self-host flow. Mounted at /v1/setup/*.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { sql } from 'drizzle-orm';
import { db, hasDatabase } from '../shared/db';
import { getSupabase } from '../shared/supabase';

export const setupApp = new Hono<AppEnv>();

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /v1/setup/install-status
 *
 * Public (no auth) — the installer/login page calls this before any user exists.
 * Returns whether the instance has been set up (i.e. an owner user exists).
 *
 * Response: { installed: boolean }
 *   installed=false → show "Create Owner Account" installer form
 *   installed=true  → show "Sign In" form
 */
setupApp.get('/install-status', async (c) => {
  try {
    if (!hasDatabase) {
      console.warn('[setup] install-status: DATABASE_URL not configured — returning 503');
      return c.json({ installed: null, error: 'Database not configured' }, 503);
    }

    // Query auth.users directly via the existing postgres connection.
    // This is reliable regardless of Supabase version / service role key format.
    const result = await db.execute(
      sql`SELECT EXISTS(SELECT 1 FROM auth.users LIMIT 1) AS has_users`
    );
    const queryResult = result as { rows?: Array<{ has_users?: boolean | 't' | 'f' }> } | Array<{ has_users?: boolean | 't' | 'f' }>;
    const row = Array.isArray(queryResult) ? queryResult[0] : queryResult.rows?.[0];
    const hasUsers = row?.has_users === true || row?.has_users === 't';

    return c.json({ installed: hasUsers });
  } catch (err) {
    console.error('[setup] install-status error:', err);
    return c.json({ installed: null, error: 'Internal error' }, 503);
  }
});

setupApp.post('/bootstrap-owner', async (c) => {
  if (!hasDatabase) {
    return c.json({ success: false, error: 'Database not configured' }, 503);
  }

  try {
    const body = await c.req.json<{ email?: string; password?: string }>();
    const email = body.email?.trim().toLowerCase() || '';
    const password = body.password || '';

    if (!email || !email.includes('@')) {
      return c.json({ success: false, error: 'Valid email is required' }, 400);
    }

    if (password.length < 6) {
      return c.json({ success: false, error: 'Password must be at least 6 characters' }, 400);
    }

    const supabase = getSupabase();
    const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (listed.error) {
      return c.json({ success: false, error: listed.error.message || 'Could not inspect existing users' }, 500);
    }
    const firstUser = listed.data?.users?.[0];
    if (firstUser) {
      return c.json({ success: false, error: 'Owner already exists' }, 409);
    }

    const { error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { is_owner: true },
    });

    if (error) {
      return c.json({ success: false, error: error.message || 'Could not create owner' }, 500);
    }

    return c.json({ success: true, created: true, email });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});
