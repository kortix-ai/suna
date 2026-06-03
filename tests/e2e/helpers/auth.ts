export const ownerEmail = process.env.E2E_OWNER_EMAIL || 'test@kortix.ai';
export const ownerPassword = process.env.E2E_OWNER_PASSWORD || 'testpass123';
export const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';

/**
 * Read the anon key from the Kortix .env file.
 */
function getAnonKey(): string {
  const fs = require('fs');
  const path = require('path');
  const explicit = (process.env.E2E_ENV_FILE || '')
    .split(path.delimiter)
    .map((item: string) => item.trim())
    .filter(Boolean);
  const envPaths = [...explicit, `${process.env.HOME}/.kortix/.env`];

  const envPath = envPaths.find((candidate: string) => fs.existsSync(candidate));
  if (!envPath) {
    throw new Error(`Kortix .env not found in ${envPaths.join(', ')} — is it installed?`);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  const match =
    content.match(/^SUPABASE_ANON_KEY=(.+)$/m) ||
    content.match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)$/m);
  if (!match) throw new Error(`SUPABASE_ANON_KEY not found in ${envPath}`);
  return match[1].trim();
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
