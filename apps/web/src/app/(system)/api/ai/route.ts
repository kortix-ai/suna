import {
  absoluteUrl,
  getPublicContentRecords,
  type PublicContentKind,
} from '@/lib/seo/public-content';
import { consumeAiIndexRateLimit } from '@/lib/seo/rate-limit';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const KINDS = new Set<PublicContentKind>(['marketing', 'blog', 'docs', 'use-case']);

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'anonymous';
}

function decodeCursor(value: string | null): number | null {
  if (!value) return 0;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (!/^\d+$/.test(decoded)) return null;
    return Number(decoded);
  } catch {
    return null;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function rateHeaders(result: ReturnType<typeof consumeAiIndexRateLimit>): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Policy': `${result.limit};w=60`,
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.ceil(result.resetsAt / 1000)),
  };
}

export function GET(request: Request): Response {
  const rate = consumeAiIndexRateLimit(clientKey(request));
  if (!rate.allowed) {
    return Response.json(
      {
        error: 'rate_limit_exceeded',
        retry_after_seconds: Math.max(1, Math.ceil((rate.resetsAt - Date.now()) / 1000)),
      },
      {
        status: 429,
        headers: {
          ...rateHeaders(rate),
          'Cache-Control': 'private, no-store',
          'Retry-After': String(Math.max(1, Math.ceil((rate.resetsAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const url = new URL(request.url);
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if (cursor === null) {
    return Response.json(
      { error: 'invalid_cursor' },
      { status: 400, headers: { ...rateHeaders(rate), 'Cache-Control': 'no-store' } },
    );
  }

  const requestedLimit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return Response.json(
      { error: 'invalid_limit', max_limit: MAX_LIMIT },
      { status: 400, headers: { ...rateHeaders(rate), 'Cache-Control': 'no-store' } },
    );
  }
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  const requestedKind = url.searchParams.get('kind') as PublicContentKind | null;
  if (requestedKind && !KINDS.has(requestedKind)) {
    return Response.json(
      { error: 'invalid_kind', allowed: [...KINDS] },
      { status: 400, headers: { ...rateHeaders(rate), 'Cache-Control': 'no-store' } },
    );
  }

  const records = getPublicContentRecords()
    .filter((record) => !requestedKind || record.kind === requestedKind)
    .sort((a, b) => a.htmlPath.localeCompare(b.htmlPath));
  const page = records.slice(cursor, cursor + limit);
  const nextOffset = cursor + page.length;

  return Response.json(
    {
      data: page.map((record) => ({
        type: record.kind,
        slug: record.slug,
        title: record.title,
        description: record.description ?? null,
        url: absoluteUrl(record.htmlPath),
        markdown_url: record.markdownPath ? absoluteUrl(record.markdownPath) : null,
        last_modified: record.lastModified ?? null,
      })),
      pagination: {
        limit,
        next_cursor: nextOffset < records.length ? encodeCursor(nextOffset) : null,
        total: records.length,
      },
    },
    {
      headers: {
        ...rateHeaders(rate),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, follow',
      },
    },
  );
}
