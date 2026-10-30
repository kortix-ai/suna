import { SESSION_COOKIE_NAME } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const res = Response.json({ ok: true });
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  return res;
}
