import { createHmac } from 'crypto';
import { writeFileSync } from 'fs';

const SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const SB = 'http://127.0.0.1:54321';
const EMAIL = process.env.MINT_EMAIL || 'test@kortix.ai';

const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
function hs256(payload: any): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const admin = hs256({ iss: 'supabase-demo', role: 'service_role', iat: now, exp: now + 600 });

// 1) admin generate_link -> email_otp
const gl: any = await (await fetch(`${SB}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: { apikey: admin, Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
})).json();
if (!gl?.email_otp) { console.log('GENLINK_FAILED', JSON.stringify(gl).slice(0, 300)); process.exit(1); }

// 2) verify otp -> real ES256 access_token
const vr: any = await (await fetch(`${SB}/auth/v1/verify`, {
  method: 'POST',
  headers: { apikey: admin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: EMAIL, token: gl.email_otp }),
})).json();
if (!vr?.access_token) { console.log('VERIFY_FAILED', JSON.stringify(vr).slice(0, 300)); process.exit(1); }

writeFileSync('/tmp/userjwt', vr.access_token);
const claims = JSON.parse(Buffer.from(vr.access_token.split('.')[1], 'base64url').toString());
console.log('JWT_OK', EMAIL, 'sub=', claims.sub, 'alg=', JSON.parse(Buffer.from(vr.access_token.split('.')[0], 'base64url').toString()).alg);
process.exit(0);
