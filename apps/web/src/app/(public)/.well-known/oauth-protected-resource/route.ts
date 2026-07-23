import { discoveryJson, oauthProtectedResourceMetadata } from '@/lib/agent-discovery';

export const dynamic = 'force-dynamic';

function requestOrigin(request: Request): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host');
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto === 'http' ? 'http' : 'https';
  if (host) {
    try {
      const forwardedOrigin = new URL(`${protocol}://${host}`);
      if (forwardedOrigin.host === host) return forwardedOrigin.origin;
    } catch {
      // Fall through to the normalized request URL.
    }
  }
  return new URL(request.url).origin;
}

export function GET(request?: Request) {
  const resource = request ? requestOrigin(request) : undefined;
  return discoveryJson(oauthProtectedResourceMetadata(resource));
}

export const HEAD = GET;
