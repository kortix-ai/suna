import { discoveryJson, OAUTH_AUTHORIZATION_SERVER_METADATA } from '@/lib/agent-discovery';

export const dynamic = 'force-static';

export function GET() {
  return discoveryJson(OAUTH_AUTHORIZATION_SERVER_METADATA);
}

export const HEAD = GET;
