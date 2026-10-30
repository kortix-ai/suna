import { wellKnownResponse } from '@kortix/shared/well-known';
export const dynamic = 'force-dynamic';
export function GET(): Response {
  return wellKnownResponse('/.well-known/security.txt') ?? new Response(null, { status: 404 });
}
