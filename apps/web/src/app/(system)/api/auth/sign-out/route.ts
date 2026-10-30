import { NextRequest, NextResponse } from 'next/server';
import { finalizeServerSignOut } from '@/lib/auth/sign-out-actions';
import { sameOriginRequest } from '@/lib/auth/submit-auth';

export async function POST(request: NextRequest) {
  if (!sameOriginRequest(request)) {
    return new NextResponse(null, { status: 403 });
  }
  await finalizeServerSignOut();
  return new NextResponse(null, { status: 204 });
}
