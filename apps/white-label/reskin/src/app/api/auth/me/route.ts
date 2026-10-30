import { getRequestSession } from '@/server/auth';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  return Response.json({ userId: session.userId });
}
