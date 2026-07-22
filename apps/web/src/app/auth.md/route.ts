import { renderAuthMd } from '@/lib/agent-discovery/auth-md';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(renderAuthMd(), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
