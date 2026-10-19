/**
 * Resolve one authenticated session preview URL on the server.
 *
 * This route owns session readiness, URL resolution, and scoped-token minting.
 * The client receives one final URL. It does not receive a standalone token,
 * an upstream base URL, or runtime coordinates.
 *
 * The member token resolves the URL. The URL carries a separate 15-minute
 * preview token minted by Convex, because the URL reaches the browser.
 */

import { isValidSessionId, memberKortix, previewToken, resolveMemberFor } from '@/server/member';
import { ApiError, appendPreviewToken, isProxiableLocalhostUrl } from '@kortix/sdk';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_PATH_LENGTH = 4096;
const MAX_TARGET_LENGTH = 8192;

interface PreviewRequest {
  projectId?: unknown;
  sessionId?: unknown;
  preview?: {
    port?: unknown;
    path?: unknown;
  };
  targetUrl?: unknown;
}

function errorResponse(status: number, error: string) {
  return Response.json({ error }, { status });
}

function parseRequest(body: PreviewRequest): {
  projectId: string;
  sessionId: string;
  target: { kind: 'preview'; port: number; path: string } | { kind: 'localhost'; url: string };
} | null {
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!projectId || !isValidSessionId(sessionId)) return null;

  if (typeof body.targetUrl === 'string') {
    const url = body.targetUrl.trim();
    if (!url || url.length > MAX_TARGET_LENGTH || !isProxiableLocalhostUrl(url)) return null;
    return { projectId, sessionId, target: { kind: 'localhost', url } };
  }

  const port = body.preview?.port;
  const path = typeof body.preview?.path === 'string' ? body.preview.path : '/';
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    path.length > MAX_PATH_LENGTH
  ) {
    return null;
  }

  return {
    projectId,
    sessionId,
    target: { kind: 'preview', port, path },
  };
}

export async function POST(req: NextRequest) {
  let body: PreviewRequest;
  try {
    body = (await req.json()) as PreviewRequest;
  } catch {
    return errorResponse(400, 'Invalid request body');
  }

  const input = parseRequest(body);
  if (!input) return errorResponse(400, 'Invalid preview request');

  const resolved = await resolveMemberFor(req, input.projectId);
  if ('error' in resolved) return resolved.error;
  const session = memberKortix(resolved.member).session(input.projectId, input.sessionId);

  try {
    await session.ensureReady();
    const previewUrl =
      input.target.kind === 'localhost'
        ? session.proxyUrl(input.target.url)
        : session.previewUrl(input.target.port, input.target.path);
    if (!previewUrl) return errorResponse(400, 'Could not resolve preview URL');
    return Response.json({ url: appendPreviewToken(previewUrl, await previewToken(resolved.member)) });
  } catch (error) {
    const status = error instanceof ApiError && error.status ? error.status : 502;
    const message = error instanceof Error ? error.message : 'Could not resolve preview URL';
    return errorResponse(status, message);
  }
}
