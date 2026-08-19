/**
 * Resolve one authenticated session preview URL on the server.
 *
 * This route owns session readiness, URL resolution, and scoped-token minting.
 * The client receives one final URL. It does not receive a standalone token,
 * an upstream base URL, or runtime coordinates.
 *
 * Wrapper mode authenticates the Lumen session and checks project ownership.
 * Direct mode forwards the caller's Kortix token through the server SDK.
 */

import {
  ApiError,
  appendPreviewToken,
  isProxiableLocalhostUrl,
  type CreatedProjectCliToken,
} from '@kortix/sdk';
import { createScopedKortix } from '@kortix/sdk/server';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isOwner, isValidProjectId } from '@/server/users';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

function upstreamBase(): string {
  return (
    process.env.KORTIX_UPSTREAM ??
    process.env.NEXT_PUBLIC_KORTIX_API_URL ??
    'https://api.kortix.com/v1'
  ).replace(/\/+$/, '');
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
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
  if (!isValidProjectId(projectId) || !UUID_RE.test(sessionId)) return null;

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
  const wrapperKey = process.env.KORTIX_API_KEY?.trim() || null;
  const appSession = wrapperKey ? getRequestSession(req) : null;
  const directToken = wrapperKey ? null : bearerToken(req);

  if (wrapperKey && !appSession) return errorResponse(401, 'Not authenticated');
  if (!wrapperKey && !directToken) return errorResponse(401, 'Not authenticated');

  let body: PreviewRequest;
  try {
    body = (await req.json()) as PreviewRequest;
  } catch {
    return errorResponse(400, 'Invalid request body');
  }

  const input = parseRequest(body);
  if (!input) return errorResponse(400, 'Invalid preview request');

  if (appSession) {
    const limited = consumeRateLimit(appSession.userId);
    if (!limited.ok) return errorResponse(429, 'Rate limit exceeded');
    if (!isOwner(appSession.userId, input.projectId)) {
      return errorResponse(403, "You don't have access to this project.");
    }
  }

  const token = wrapperKey ?? directToken;
  if (!token) return errorResponse(401, 'Not authenticated');

  const kortix = createScopedKortix({
    backendUrl: upstreamBase(),
    getToken: async () => token,
  });
  const session = kortix.session(input.projectId, input.sessionId);

  let previewUrl: string | undefined;
  let created: CreatedProjectCliToken;
  try {
    await session.ensureReady();
    previewUrl =
      input.target.kind === 'localhost'
        ? session.proxyUrl(input.target.url)
        : session.previewUrl(input.target.port, input.target.path);
    if (!previewUrl) return errorResponse(400, 'Could not resolve preview URL');

    created = await kortix
      .project(input.projectId)
      .tokens.create({ name: `lumen-preview-${Date.now()}` });
  } catch (error) {
    const status = error instanceof ApiError && error.status ? error.status : 502;
    const message = error instanceof Error ? error.message : 'Could not resolve preview URL';
    return errorResponse(status, message);
  }

  if (!created?.secret_key) {
    return errorResponse(502, 'Could not mint a preview token');
  }

  return Response.json({
    url: appendPreviewToken(previewUrl, created.secret_key),
    tokenId: created.token_id,
  });
}
