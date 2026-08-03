import { renderRobotsTxt } from '@/lib/seo/robots';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  return new Response(renderRobotsTxt(host), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
}
