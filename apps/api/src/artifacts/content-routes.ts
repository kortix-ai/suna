// The artifact content server — UNAUTHENTICATED, capability-gated. It serves an
// artifact's files from its version manifest; a doc's index.html gets the doc
// stylesheet, and `?print=1` opens the print dialog (Download PDF). Forms:
//   /v1/artifacts/s/:token/<path>   a signed view token (private, project and
//                                   shared artifacts; minted by the
//                                   authenticated routes for one version)
//   /v1/artifacts/p/:artifactId/<path>  a public artifact's current version
//   /v1/artifacts/meta/:artifactId      a public artifact's title and type
// Every response is a CSP sandbox without same-origin: the page runs scripts
// in an opaque origin, so it reaches no Kortix cookie, storage or API session.
import { Hono, type Context } from 'hono';
import { verifyChannelState } from '../channels/core/signed-state';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { createArtifactContentRateLimitMiddleware } from '../middleware/rate-limit';
import { PUBLIC_SHARE_SANDBOX_CSP } from '../sandbox-proxy/routes/public-share';
import { isUuid } from '../shared/validate';
import { DriveStorageError } from '../drives/volumes';
import { renderEntry } from './formats';
import { ARTIFACTS_FLAG, ENTRY_PATH, artifactPublicContentUrl, getArtifactById, getVersion, normalizeArtifactPath, readArtifactFile, type ArtifactRow } from './service';

export const artifactContentApp = new Hono();

function notFound(c: Context): Response {
  return c.html(
    '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font:14px system-ui;color:#666;display:grid;place-items:center;height:90vh;margin:0">This artifact is not available.</body>',
    404,
    { 'Content-Security-Policy': PUBLIC_SHARE_SANDBOX_CSP, 'Cache-Control': 'no-store' },
  );
}

/** The part of the request path after `/<prefix>/<key>/`. */
function restOf(c: Context, key: string): string | null {
  const path = c.req.path;
  const at = path.indexOf(`/${key}/`);
  if (at < 0) return null;
  try {
    return decodeURIComponent(path.slice(at + key.length + 2));
  } catch {
    return null;
  }
}

async function serve(c: Context, row: ArtifactRow | null, version: number | null, rest: string, cache: string): Promise<Response> {
  if (!row || !(await projectFeatureFlagEnabled(row.projectId, ARTIFACTS_FLAG))) return notFound(c);
  const v = await getVersion(row.artifactId, version ?? row.currentVersion);
  if (!v) return notFound(c);
  const wanted = rest === '' || rest.endsWith('/') ? `${rest}${ENTRY_PATH}` : rest;
  const path = normalizeArtifactPath(wanted);
  const resolved = path && (v.files[path] ? path : v.files[`${path}/${ENTRY_PATH}`] ? `${path}/${ENTRY_PATH}` : v.files[`${path}.html`] ? `${path}.html` : null);
  if (!resolved) return notFound(c);
  const file = v.files[resolved]!;
  let upstream: Response;
  try {
    upstream = await readArtifactFile(row, file);
  } catch (err) {
    if (err instanceof DriveStorageError && err.status === 404) return notFound(c);
    throw err;
  }
  const headers: Record<string, string> = {
    'Content-Type': file.content_type,
    'Content-Security-Policy': PUBLIC_SHARE_SANDBOX_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*',
  };
  const print = c.req.query('print') === '1';
  if (resolved === ENTRY_PATH && (row.type === 'doc' || print)) {
    return c.body(renderEntry(await upstream.text(), row.type, { print }), 200, headers);
  }
  return new Response(upstream.body, { status: 200, headers: { ...headers, 'Content-Length': String(file.size) } });
}

export function registerArtifactContentRoutes(): void {
  artifactContentApp.use('/s/:token/*', createArtifactContentRateLimitMiddleware((c) => `s:${c.req.param('token')?.split('.')[0] ?? ''}`));
  artifactContentApp.use('/p/:artifactId/*', createArtifactContentRateLimitMiddleware((c) => `p:${c.req.param('artifactId') ?? ''}`));

  // Without the trailing slash, relative URLs in the page would resolve one level up.
  artifactContentApp.get('/s/:token', (c) => c.redirect(`${c.req.path}/`, 301));
  artifactContentApp.get('/p/:artifactId', (c) => c.redirect(`${c.req.path}/`, 301));

  artifactContentApp.get('/s/:token/*', async (c) => {
    const token = c.req.param('token');
    const claim = verifyChannelState('artifact-view', token);
    const rest = restOf(c, token);
    if (!claim || typeof claim.a !== 'string' || typeof claim.v !== 'number' || rest === null) return notFound(c);
    // A version never changes, so the browser may keep it as long as the token lives.
    return serve(c, await getArtifactById(claim.a), claim.v, rest, 'private, max-age=3600');
  });

  // The public page's chrome (title, type): a public artifact of a flag-on project, else 404.
  artifactContentApp.use('/meta/:artifactId', createArtifactContentRateLimitMiddleware((c) => `p:${c.req.param('artifactId') ?? ''}`));
  artifactContentApp.get('/meta/:artifactId', async (c) => {
    const id = c.req.param('artifactId');
    const row = isUuid(id) ? await getArtifactById(id) : null;
    if (!row || row.visibility !== 'public' || !(await projectFeatureFlagEnabled(row.projectId, ARTIFACTS_FLAG))) {
      return c.json({ error: 'Artifact not found' }, 404);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({
      artifact_id: row.artifactId,
      title: row.title,
      description: row.description,
      type: row.type,
      updated_at: row.updatedAt.toISOString(),
      content_url: artifactPublicContentUrl(row.artifactId),
    });
  });

  artifactContentApp.get('/p/:artifactId/*', async (c) => {
    const id = c.req.param('artifactId');
    const rest = restOf(c, id);
    if (!isUuid(id) || rest === null) return notFound(c);
    const row = await getArtifactById(id);
    // Revoking public access must take effect at once: no shared cache.
    return serve(c, row?.visibility === 'public' ? row : null, null, rest, 'public, max-age=0, must-revalidate');
  });
}
