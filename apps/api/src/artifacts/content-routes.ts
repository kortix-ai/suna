// The artifact content server — UNAUTHENTICATED, capability-gated. It serves an
// artifact's files from Files (at a commit for an old version); a doc's Markdown is rendered with the doc
// stylesheet, and `?print=1` on a doc opens the print dialog (Export as PDF). Forms:
//   /v1/artifacts/s/:token/<path>   a signed view token (private, project and
//                                   shared artifacts; minted by the
//                                   authenticated routes, latest or one commit)
//   /v1/artifacts/p/:artifactId/<path>  a public artifact's current version
//   /v1/artifacts/meta/:artifactId      a public artifact's title and type
// Every response is a CSP sandbox. On the API origin it has no same-origin: the
// page runs in an opaque origin and reaches no Kortix cookie, storage or API
// session. On ARTIFACT_CONTENT_URL (another site) the page keeps that origin, so
// an embedded player that needs an origin (YouTube, Vimeo) plays.
import { Hono, type Context } from 'hono';
import { config } from '../config';
import { verifyChannelState } from '../channels/core/signed-state';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { createArtifactContentRateLimitMiddleware } from '../middleware/rate-limit';
import { PUBLIC_SHARE_SANDBOX_CSP } from '../sandbox-proxy/routes/public-share';
import { isUuid } from '../shared/validate';
import { DriveStorageError } from '../drives/volumes';
import { renderDoc } from './formats';
import { ARTIFACTS_FLAG, artifactPrivateFolder, artifactPublicContentUrl, contentTypeFor, getArtifactById, normalizeArtifactPath, readArtifactFile, type ArtifactRow } from './service';

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

/** Read one file of the artifact, trying `x/index.html` and `x.html` for a path without one. Null when none exists. */
async function readFirst(row: ArtifactRow, paths: string[], at: string | null, range?: string) {
  for (const path of paths) {
    try {
      return { path, response: await readArtifactFile(row, path, at, range) };
    } catch (err) {
      if (!(err instanceof DriveStorageError && err.status === 404)) throw err;
    }
  }
  return null;
}

// ponytail: one origin for every artifact (pages share its storage); a wildcard
// host per artifact (`<id>.<content host>`) when that matters.
function sandboxCsp(c: Context): string {
  const own = config.ARTIFACT_CONTENT_URL && new URL(config.ARTIFACT_CONTENT_URL).host === new URL(c.req.url).host;
  return own ? `${PUBLIC_SHARE_SANDBOX_CSP} allow-same-origin` : PUBLIC_SHARE_SANDBOX_CSP;
}

async function serve(c: Context, row: ArtifactRow | null, at: string | null, rest: string, cache: string): Promise<Response> {
  if (!row || !(await projectFeatureFlagEnabled(row.projectId, ARTIFACTS_FLAG))) return notFound(c);
  const wanted = rest === '' ? row.entry : normalizeArtifactPath(rest.endsWith('/') ? `${rest}index.html` : rest);
  if (!wanted) return notFound(c);
  const isEntry = wanted === row.entry;
  // A Range read (a video seeking) passes through; the entry page is always read whole.
  const range = isEntry ? undefined : c.req.header('range');
  const found = await readFirst(row, /\.[a-z0-9]+$/i.test(wanted) ? [wanted] : [wanted, `${wanted}/index.html`, `${wanted}.html`], at, range);
  if (!found) return notFound(c);
  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(found.path),
    'Content-Security-Policy': sandboxCsp(c),
    'X-Content-Type-Options': 'nosniff',
    // Third parties (an embedded player) see only the API origin, never the token in the path.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*',
  };
  if (found.path === row.entry && row.type === 'doc') {
    const html = renderDoc(await found.response.text(), { print: c.req.query('print') === '1' });
    return c.body(html, 200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
  }
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = found.response.headers.get(name);
    if (value) headers[name] = value;
  }
  headers['Accept-Ranges'] = 'bytes';
  return new Response(found.response.body, { status: found.response.status === 206 ? 206 : 200, headers });
}

/** A public route's bucket: the artifact id when it is one, else the client's. */
function publicKey(c: Context): string | null {
  const id = c.req.param('artifactId');
  return id && isUuid(id) ? `a:${id}` : null;
}

export function registerArtifactContentRoutes(): void {
  artifactContentApp.use('/s/:token/*', createArtifactContentRateLimitMiddleware((c) => {
    const artifact = verifyChannelState('artifact-view', c.req.param('token'))?.a;
    return typeof artifact === 'string' ? `a:${artifact}` : null;
  }));
  artifactContentApp.use('/p/:artifactId/*', createArtifactContentRateLimitMiddleware(publicKey));

  // Without the trailing slash, relative URLs in the page would resolve one level up.
  artifactContentApp.get('/s/:token', (c) => c.redirect(`${c.req.path}/`, 301));
  artifactContentApp.get('/p/:artifactId', (c) => c.redirect(`${c.req.path}/`, 301));

  artifactContentApp.get('/s/:token/*', async (c) => {
    const token = c.req.param('token');
    const claim = verifyChannelState('artifact-view', token);
    const rest = restOf(c, token);
    if (!claim || typeof claim.a !== 'string' || rest === null) return notFound(c);
    const at = typeof claim.c === 'string' ? claim.c : null;
    // A commit never changes, so the browser may keep it; the latest state must revalidate.
    return serve(c, await getArtifactById(claim.a), at, rest, at ? 'private, max-age=3600' : 'private, no-cache');
  });

  // The public page's chrome (title, type): a public artifact of a flag-on project, else 404.
  artifactContentApp.use('/meta/:artifactId', createArtifactContentRateLimitMiddleware(publicKey));
  artifactContentApp.get('/meta/:artifactId', async (c) => {
    const id = c.req.param('artifactId');
    const row = isUuid(id) ? await getArtifactById(id) : null;
    if (!row || row.visibility !== 'public' || (await artifactPrivateFolder(row)) || !(await projectFeatureFlagEnabled(row.projectId, ARTIFACTS_FLAG))) {
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
    // A private channel's artifact is never public, whatever its row says.
    return serve(c, row?.visibility === 'public' && !(await artifactPrivateFolder(row)) ? row : null, null, rest, 'public, max-age=0, must-revalidate');
  });
}
