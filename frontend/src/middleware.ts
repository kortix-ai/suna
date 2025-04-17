import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from './lib/supabase/middleware';

export const middleware = (request: NextRequest) => {
  return validateSession(request);
};

// Apply middleware to all routes
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/webhooks).*)'],
}; 