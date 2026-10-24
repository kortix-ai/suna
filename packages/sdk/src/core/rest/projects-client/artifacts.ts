// Artifacts (project flag `artifacts`): paths in the project's Files volume
// shared as a `doc` (a Markdown file people edit in place) or an `html` page
// (a file, or a folder with index.html: decks, dashboards, mockups, tools).
// The files are plain files in Files; their history is the Files commit log
// (`listArtifactVersions`). `listArtifactTypes` has each format and a starter. Visibility: private (the creator and
// `shared_with_user_ids`), project (every member), public (anyone with the
// link). Permissions: `project.artifact.read` (read), `.write` (publish,
// save, your own sharing), `.manage` (anyone's sharing), `.public` (public links).

import { ApiError, backendApi } from '../../http/api-client';
import { authenticatedFetch } from '../../http/auth';
import { platformConfig } from '../../http/config';
import { stripTrailingSlashes } from '../../../platform/strings';
import { unwrap } from './shared';

/** `doc`: a document Kortix styles and people edit in place. `html`: any page or bundle, served as written. */
export type ArtifactType = 'doc' | 'html';
export type ArtifactVisibility = 'private' | 'project' | 'public';
export type ArtifactListScope = 'all' | 'mine' | 'shared' | 'pinned';

export interface ArtifactPerson {
  user_id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface Artifact {
  artifact_id: string;
  project_id: string;
  title: string;
  description: string | null;
  type: ArtifactType;
  /** The shared path in Files: a folder, or a single file. */
  path: string;
  /** The page a reader opens: `index.md` / `index.html` in a folder, or the file's name. */
  entry: string;
  visibility: ArtifactVisibility;
  shared_with_user_ids: string[];
  /** Pinned by the caller. */
  pinned: boolean;
  created_by: ArtifactPerson;
  created_by_session_id: string | null;
  /** The caller may share, rename or unshare it. */
  can_manage: boolean;
  /** Signed URL of the current state, valid 12 h. Embed it in an iframe. */
  view_url: string;
  /** The artifact in the Kortix app. */
  web_url: string;
  /** Anyone-with-the-link page, when public. */
  public_url: string | null;
  /** The raw page without Kortix chrome, when public. */
  public_content_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactFile {
  path: string;
  size: number;
  content_type: string;
}

/** One save of the artifact, read from the Files commit log. */
export interface ArtifactVersion {
  /** The Files commit that made it: pass it as `version` to read or restore it. */
  id: string;
  /** 1 for the oldest save in the history window. */
  number: number;
  created_at: string;
}

export interface ArtifactDetail extends Artifact {
  /** The caller may write its files (write access to its path in Files). */
  can_edit: boolean;
  /** The entry file's version now: pass it as `base_version` when you save. */
  entry_version: string | null;
  version: { id: string | null; files: ArtifactFile[]; view_url: string };
}

export interface ArtifactTypeInfo {
  type: ArtifactType;
  name: string;
  description: string;
  /** How to write this type, in Markdown. */
  format: string;
  /** A complete example. */
  starter: string;
}

/** One file of a publish: text, or bytes as base64. */
export interface ArtifactFileInput {
  content?: string;
  content_base64?: string;
}

export interface PublishArtifactInput {
  title?: string;
  description?: string | null;
  /** Default private. */
  visibility?: ArtifactVisibility;
  /** path → file. `index.md` makes a doc, `index.html` a page. Stored in your folder in Files. */
  files: Record<string, ArtifactFileInput>;
}

export interface ShareArtifactPathInput {
  /** A path in Files: a .md or .html file, or a folder with index.md or index.html. */
  path: string;
  title?: string;
  description?: string | null;
  visibility?: ArtifactVisibility;
}

export interface SaveArtifactInput {
  title?: string;
  description?: string | null;
  /** path → file, written into the artifact in Files. */
  files: Record<string, ArtifactFileInput>;
  /** The `entry_version` you edited; a newer save fails with 409 `version_conflict`. */
  base_version?: string;
}

export interface UpdateArtifactInput {
  title?: string;
  description?: string | null;
  visibility?: ArtifactVisibility;
  /** People who may view a private artifact. Replaces the list. */
  shared_with_user_ids?: string[];
}

const base = (projectId: string) => `/projects/${projectId}/artifacts`;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function listArtifactTypes(projectId: string) {
  return unwrap(await backendApi.get<{ types: ArtifactTypeInfo[] }>(`${base(projectId)}/types`)).types;
}

export async function listArtifacts(
  projectId: string,
  options: { scope?: ArtifactListScope; type?: ArtifactType; q?: string; limit?: number } = {},
) {
  return unwrap(await backendApi.get<{ artifacts: Artifact[] }>(`${base(projectId)}${query(options)}`)).artifacts;
}

export async function getArtifact(projectId: string, artifactId: string, options: { version?: string } = {}) {
  return unwrap(await backendApi.get<ArtifactDetail>(`${base(projectId)}/${artifactId}${query(options)}`));
}

export async function createArtifact(projectId: string, input: PublishArtifactInput) {
  return unwrap(await backendApi.post<ArtifactDetail>(base(projectId), input));
}

/** Share a path that is already in Files as an artifact. */
export async function shareArtifactPath(projectId: string, input: ShareArtifactPathInput) {
  return unwrap(await backendApi.post<ArtifactDetail>(`${base(projectId)}/share`, input));
}

/** Save files into the artifact in Files. */
export async function saveArtifact(projectId: string, artifactId: string, input: SaveArtifactInput) {
  return unwrap(await backendApi.put<ArtifactDetail>(`${base(projectId)}/${artifactId}`, input));
}

/** Rename or share. */
export async function updateArtifact(projectId: string, artifactId: string, input: UpdateArtifactInput) {
  return unwrap(await backendApi.patch<Artifact>(`${base(projectId)}/${artifactId}`, input));
}

/** Stop sharing: it leaves Artifacts; its files stay in Files. */
export async function deleteArtifact(projectId: string, artifactId: string) {
  return unwrap(await backendApi.delete<{ deleted: true }>(`${base(projectId)}/${artifactId}`));
}

export async function setArtifactPinned(projectId: string, artifactId: string, pinned: boolean) {
  const path = `${base(projectId)}/${artifactId}/pin`;
  return unwrap(pinned ? await backendApi.put<Artifact>(path) : await backendApi.delete<Artifact>(path));
}

export async function listArtifactVersions(projectId: string, artifactId: string) {
  return unwrap(await backendApi.get<{ versions: ArtifactVersion[] }>(`${base(projectId)}/${artifactId}/versions`)).versions;
}

/** Write an old version back to Files, as a new save. */
export async function restoreArtifactVersion(projectId: string, artifactId: string, version: string) {
  return unwrap(await backendApi.post<ArtifactDetail>(`${base(projectId)}/${artifactId}/restore`, { version }));
}

/** One file's source as stored in Files, default the entry file now. */
export async function readArtifactFile(
  projectId: string,
  artifactId: string,
  options: { path?: string; version?: string; signal?: AbortSignal } = {},
): Promise<Blob> {
  const url = `${stripTrailingSlashes(platformConfig().backendUrl)}${base(projectId)}/${artifactId}/content${query({ path: options.path, version: options.version })}`;
  const response = await authenticatedFetch(url, { signal: options.signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(body?.error || body?.message || 'Could not read the artifact', { status: response.status });
  }
  return response.blob();
}
