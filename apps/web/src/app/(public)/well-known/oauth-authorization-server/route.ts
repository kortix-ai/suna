import { buildAuthorizationServerMetadata } from '@/lib/agent-discovery/oauth-metadata';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(
    `${JSON.stringify(buildAuthorizationServerMetadata(), null, 2)}\n`,
    {
      headers: {
        'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
