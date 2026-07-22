import { buildSkillsIndex } from '@/lib/agent-discovery/skills';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(`${JSON.stringify(buildSkillsIndex(), null, 2)}\n`, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
