import { AGENT_SKILLS, readSkillBody } from '@/lib/agent-discovery/skills';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export function generateStaticParams(): { name: string }[] {
  return AGENT_SKILLS.map((skill) => ({ name: skill.name }));
}

export async function GET(
  _: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  const body = readSkillBody(name);
  if (body === null) return new Response('Not found\n', { status: 404 });

  return new Response(body, {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
