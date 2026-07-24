import { getPublicContentRecords, resolvePublicMarkdown } from '@/lib/seo/public-content';
import { markdownResponse } from '@/lib/seo/response';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const htmlPath =
    request.headers.get('x-kortix-markdown-path') ?? new URL(request.url).searchParams.get('path');
  if (!htmlPath?.startsWith('/') || htmlPath.startsWith('//')) {
    return new Response('Invalid path\n', { status: 400 });
  }

  const record = getPublicContentRecords().find(
    (candidate) => candidate.htmlPath === htmlPath && candidate.markdownPath,
  );
  if (!record?.markdownPath) {
    return new Response('Markdown representation not found\n', { status: 404 });
  }

  const resolved = resolvePublicMarkdown(
    record.markdownPath.replace(/^\/markdown\//, '').split('/'),
  );
  if (!resolved) return new Response('Markdown representation not found\n', { status: 404 });
  return markdownResponse(resolved.markdown, resolved.record);
}
