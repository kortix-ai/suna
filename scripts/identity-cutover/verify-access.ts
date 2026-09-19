import { createHmac } from 'node:crypto';

const projectId = 'c2600241-764a-4f80-9683-d6d73a6d0328';
const ssoProviderId = '12bc7d10-9907-49d7-87a7-c7edcaa3f4e5';
const cases = [
  { email: 'chunt@libremax.com', old: '390dc4bb-00dc-4f64-831a-9240a20e5754', sso: 'c5b5fe1d-5c55-496f-9529-7cb13dc0509e', session: 'b41f39cc-7512-4e9b-b18d-d8af99ff419f', deprovisioned: false },
  { email: 'pmcatee@libremax.com', old: '1d77603c-e59b-4d61-bb5f-172823b38b5c', sso: '529b2c25-3137-4eff-9233-85ad4abd8fe6', session: '45ac05c4-1e97-4e76-8acd-3b6a96a449b7', deprovisioned: false },
  { email: 'swong@libremax.com', old: 'd6f73c99-397f-4d72-9d56-9a59f16d108a', sso: '6bb48934-e7c4-4c22-9d67-b1a9a7e24140', session: '2bf008da-a910-466e-a262-fdc5cd2e530f', deprovisioned: false },
  { email: 'uvanajarenukaprasad@libremax.com', old: 'c88dd96d-d224-4e08-8c77-f80c08023894', sso: '595f58d9-5b34-4a8e-af8d-cea51226f5e7', session: '7dd81b21-4f28-4250-bc33-b5b735dfd843', deprovisioned: true },
] as const;
const phase = process.argv.find(x => x.startsWith('--phase='))?.slice(8);
if (phase !== 'before' && phase !== 'after') throw Error('Pass --phase=before|after');
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) throw Error('SUPABASE_JWT_SECRET required');
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function token(userId: string, email: string, sso: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const appMetadata = sso ? { provider: `sso:${ssoProviderId}`, providers: [`sso:${ssoProviderId}`] } : { provider: 'email', providers: ['email'] };
  const raw = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iss: `${process.env.SUPABASE_URL}/auth/v1`, sub: userId, aud: 'authenticated', role: 'authenticated', email, app_metadata: appMetadata, iat: now, exp: now + 300 })}`;
  return `${raw}.${createHmac('sha256', jwtSecret!).update(raw).digest('base64url')}`;
}
for (const row of cases) {
  for (const identity of ['old', 'sso'] as const) {
    const response = await fetch(`https://api.kortix.com/v1/projects/${projectId}/sessions/${row.session}`, {
      headers: { Authorization: `Bearer ${token(row[identity], row.email, identity === 'sso')}` },
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => ({}));
    const expected = phase === 'after'
      ? identity === 'sso' && !row.deprovisioned
      : identity === 'old' && !row.deprovisioned;
    if (expected && response.status !== 200) throw Error(`${row.email} ${identity}: expected 200, got ${response.status}`);
    if (!expected && ![403, 404].includes(response.status)) throw Error(`${row.email} ${identity}: expected deny, got ${response.status}`);
    console.log(JSON.stringify({ phase, email: row.email, identity, status: response.status, session_id: row.session, created_by: body.created_by ?? body.session?.created_by ?? null }));
  }
}
