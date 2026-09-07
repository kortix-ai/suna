import { verifySupabaseJwt } from '../shared/jwt-verify';
import { isInconclusiveVerifyFailure } from '../shared/jwt-verify-outcome';
import { getSupabase } from '../shared/supabase';

async function isPlatformToken(token: string): Promise<boolean> {
  if (token.startsWith('kortix_')) return true;
  if (token.split('.').length !== 3) return false;

  const local = await verifySupabaseJwt(token);
  if (local.ok) return true;
  if (!isInconclusiveVerifyFailure(local.reason)) return false;

  try {
    const { data: { user }, error } = await getSupabase().auth.getUser(token);
    if (!error) return !!user;
    const status = typeof error.status === 'number' ? error.status : null;
    // A normal 4xx auth verdict proves this is not a valid Supabase token.
    // Rate limits, server failures, and errors without a status cannot prove
    // that. Treat those as platform credentials so they never reach the app.
    return status === 429 || status === null || status < 400 || status >= 500;
  } catch {
    return true;
  }
}

export async function selectPreviewWsUpstreamQuery(
  search: string,
  input: { cookieAuthenticated: boolean; carriesSessionData: boolean },
): Promise<{ queryString: string; wakeRequested: boolean }> {
  const query = new URLSearchParams(search);
  const wakeRequested = query.get('wake') === '1';
  const entries = [...query.entries()];
  const tokenDecisions = input.cookieAuthenticated && !input.carriesSessionData
    ? await Promise.all(entries.map(async ([name, value]) =>
      name === 'token' ? !(await isPlatformToken(value)) : true))
    : entries.map(([name]) => name !== 'token');
  const upstream = new URLSearchParams();
  entries.forEach(([name, value], index) => {
    if (name === 'public_share' || name === 'wake') return;
    if (name === 'token' && !tokenDecisions[index]) return;
    upstream.append(name, value);
  });
  const encoded = upstream.toString();
  return { queryString: encoded ? `?${encoded}` : '', wakeRequested };
}
