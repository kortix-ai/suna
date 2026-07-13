import { resolvePublicMarkdown } from '@/lib/seo/public-content';
import { markdownResponse } from '@/lib/seo/response';

export const dynamic = 'force-static';
export const revalidate = 3600;

export async function GET(_: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const result = resolvePublicMarkdown(path);
  if (!result) return new Response('Not found\n', { status: 404 });
  return markdownResponse(result.markdown, result.record);
}
