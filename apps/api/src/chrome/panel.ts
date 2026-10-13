/**
 * Side panel sign-in for the Kortix in Chrome extension.
 *
 * Chrome hides SameSite=Lax cookies from a frame inside an extension page, so
 * the side panel cannot reuse the web session of the user's tab. The extension
 * asks here for a one-time token hash for the user it already acts as, and
 * hands it to the framed web app. The web app trades it for its own session in
 * a partitioned cookie. No email is sent, and the user's tab session is not
 * touched.
 */
import { isKortixExtensionClient } from '../oauth/extension-client';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { getSupabase } from '../shared/supabase';
import { ChromeError } from './logic';

// replica-local: per-instance bucket; the one-time token is the real limit.
const panelLimiter = new TokenBucketRateLimiter('chrome_panel_session');
export const PANEL_SESSION_POLICY = { limit: 10, windowMs: 60_000 };

export class PanelRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many side panel sign-ins');
  }
}

export interface PanelCaller {
  userId: string;
  authType: string | undefined;
  oauthClientId: string | undefined;
}

/** Mint a one-time magic-link token hash for the caller. Only the extension's OAuth token may call. */
export async function createPanelSession(caller: PanelCaller): Promise<{ tokenHash: string }> {
  if (caller.authType !== 'oauth' || !(await isKortixExtensionClient(caller.oauthClientId))) {
    throw new ChromeError('chrome_panel_forbidden');
  }
  const limit = panelLimiter.check(caller.userId, PANEL_SESSION_POLICY);
  if (!limit.allowed) throw new PanelRateLimited(Math.ceil((limit.retryAfterMs ?? 1000) / 1000));

  const admin = getSupabase().auth.admin;
  const { data: found, error: lookupError } = await admin.getUserById(caller.userId);
  if (lookupError) throw lookupError;
  const email = found.user?.email;
  if (!email) throw new ChromeError('chrome_panel_no_email');

  const { data, error } = await admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error('GoTrue returned no hashed_token');
  return { tokenHash };
}
