import { renderLlmsTxt } from '@/lib/seo/llms';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET() {
  return new Response(renderLlmsTxt(), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
