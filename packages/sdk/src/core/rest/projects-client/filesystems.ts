/**
 * Shared filesystems — "a Google Drive between the agents".
 *
 * A named volume of state, scoped to a project and shared by every agent in it,
 * that outlives the sessions which read and write it. Distinct from the project
 * FILES surface (`getProjectFiles`), which reads the git repo: that is config,
 * cloned per session and versioned; this is state.
 *
 * Metadata calls go through `backendApi` like every other domain here. The two
 * BYTE calls do not, for one reason: `backendApi.put` JSON-stringifies its body,
 * which would turn `# Plan` into `"# Plan"` and stamp it `application/json` —
 * silently corrupting every file the SDK writes. Those two use
 * `authenticatedFetch`, the same auth seam underneath, with no JSON layer.
 */
import { authenticatedFetch } from '../../http/auth';
import { backendApi } from '../../http/api-client';
import { platformConfig } from '../../http/config';
import { unwrap } from './shared';

export interface KortixFilesystem {
  filesystem_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface KortixFilesystemFile {
  path: string;
  size: number;
  sha256: string;
  content_type: string;
  /** Which blob backend holds the bytes: 's3' or 'pg'. */
  storage: string;
  created_at: string;
  updated_at: string;
}

export interface KortixFilesystemFileContent {
  bytes: Uint8Array;
  contentType: string;
  /** The server's etag is the content sha256; absent if the server omitted it. */
  sha256: string | null;
  /** Decode as UTF-8. Already-read bytes — this issues no second request. */
  text(): string;
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/filesystems`;
const fsBase = (projectId: string, name: string) =>
  `${base(projectId)}/${encodeURIComponent(name)}`;

/**
 * The file path is a QUERY parameter, not a URL segment: a path contains
 * slashes and the API's typed router matches one segment per parameter, so a
 * nested path in the URL never reaches the route.
 */
const contentUrl = (projectId: string, name: string, path: string) =>
  `${fsBase(projectId, name)}/files/content?path=${encodeURIComponent(path)}`;

function absolute(endpoint: string): string {
  return `${platformConfig().backendUrl || ''}${endpoint}`;
}

export async function listProjectFilesystems(projectId: string): Promise<KortixFilesystem[]> {
  const res = await backendApi.get<{ filesystems: KortixFilesystem[] }>(base(projectId));
  return unwrap(res, 'Failed to list filesystems').filesystems ?? [];
}

export async function createProjectFilesystem(
  projectId: string,
  input: { name: string; description?: string },
): Promise<KortixFilesystem> {
  const res = await backendApi.post<KortixFilesystem>(base(projectId), input);
  return unwrap(res, 'Failed to create filesystem');
}

export async function deleteProjectFilesystem(projectId: string, name: string): Promise<void> {
  unwrap(await backendApi.delete(fsBase(projectId, name)), 'Failed to delete filesystem');
}

export async function listProjectFilesystemFiles(
  projectId: string,
  name: string,
  options?: { prefix?: string; limit?: number },
): Promise<KortixFilesystemFile[]> {
  const query = new URLSearchParams();
  if (options?.prefix) query.set('prefix', options.prefix);
  if (typeof options?.limit === 'number') query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const res = await backendApi.get<{ files: KortixFilesystemFile[] }>(
    `${fsBase(projectId, name)}/files${suffix}`,
  );
  return unwrap(res, 'Failed to list filesystem files').files ?? [];
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

async function failureMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = text ? (JSON.parse(text) as { error?: string; message?: string }) : null;
    return parsed?.error || parsed?.message || `${fallback} (${res.status})`;
  } catch {
    return text ? `${fallback}: ${text.slice(0, 200)}` : `${fallback} (${res.status})`;
  }
}

export async function writeProjectFilesystemFile(
  projectId: string,
  name: string,
  path: string,
  content: string | Uint8Array,
  options?: { contentType?: string },
): Promise<KortixFilesystemFile> {
  const bytes = toBytes(content);
  const res = await authenticatedFetch(absolute(contentUrl(projectId, name, path)), {
    method: 'PUT',
    headers: { 'content-type': options?.contentType || 'application/octet-stream' },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new Error(await failureMessage(res, 'Failed to write file'));
  return (await res.json()) as KortixFilesystemFile;
}

export async function readProjectFilesystemFile(
  projectId: string,
  name: string,
  path: string,
): Promise<KortixFilesystemFileContent> {
  const res = await authenticatedFetch(absolute(contentUrl(projectId, name, path)), {
    method: 'GET',
  });
  if (!res.ok) throw new Error(await failureMessage(res, 'Failed to read file'));
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    bytes,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    sha256: (res.headers.get('etag') || '').replace(/^"|"$/g, '') || null,
    text: () => new TextDecoder().decode(bytes),
  };
}

export async function deleteProjectFilesystemFile(
  projectId: string,
  name: string,
  path: string,
): Promise<void> {
  const res = await authenticatedFetch(absolute(contentUrl(projectId, name, path)), {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await failureMessage(res, 'Failed to delete file'));
}
