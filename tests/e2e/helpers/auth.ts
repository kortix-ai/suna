import { optionalEnvValue } from './env';

export const ownerEmail = process.env.E2E_OWNER_EMAIL || 'test-e2e@kortix.ai';
export const ownerPassword = process.env.E2E_OWNER_PASSWORD || 'e2e-testpass-123';
export const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';

/**
 * Read the anon key from the Kortix .env file.
 */
function getAnonKey(): string {
  const fallback = `${process.env.HOME}/.kortix/.env`;
  const value =
    optionalEnvValue('SUPABASE_ANON_KEY', fallback) ||
    optionalEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', fallback);
  if (!value) throw new Error(`SUPABASE_ANON_KEY not found in E2E_ENV_FILE or ${fallback}`);
  return value;
}

/**
 * Sign in via Supabase Auth API and return an access token.
 */
export async function getAccessToken(
  email = ownerEmail,
  password = ownerPassword,
): Promise<string> {
  const anonKey = getAnonKey();
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}
