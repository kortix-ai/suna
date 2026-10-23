// Artifacts (project flag `artifacts`): HTML people and agents publish in a
// project — a `doc` (a document edited in place; publish Markdown or HTML) or
// an `html` page or bundle (decks, dashboards, mockups, tools). Each publish is
// a version (`listArtifactTypes` has each format and a starter page). Visibility: private (the creator and
// `shared_with_user_ids`), project (every member), public (anyone with the
// link). Reading needs `project.read`; publishing `project.session.start`;
// changing an artifact its creator or project.write.

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
  icon: string | null;
  visibility: ArtifactVisibility;
  shared_with_user_ids: string[];
  /** Pinned by the caller. */
  pinned: boolean;
  current_version: number;
  created_by: ArtifactPerson;
  created_by_session_id: string | null;
  /** The caller may publish, rename, share or delete it. */
  can_edit: boolean;
  /** Signed URL of the current version, valid 12 h. Embed it in an iframe. */
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

export interface ArtifactVersion {
  version: number;
  label: string | null;
  files: ArtifactFile[];
  created_by_user_id: string;
  created_by_session_id: string | null;
  created_at: string;
}

export interface ArtifactDetail extends Artifact {
  version: ArtifactVersion & { view_url: string };
}

export interface ArtifactTypeInfo {
  type: ArtifactType;
  name: string;
  description: string;
  /** How to write this type, in Markdown. */
  format: string;
  /** A complete example page; also the "start blank" template. */
  starter: string;
}

/** One file of a publish: text, or bytes as base64. */
export interface ArtifactFileInput {
  content?: string;
  content_base64?: string;
  content_type?: string;
}

export interface PublishArtifactInput {
  title?: string;
  description?: string | null;
  type?: ArtifactType;
  icon?: string | null;
  /** New artifacts only. Default private. */
  visibility?: ArtifactVisibility;
  /** A short name for this version. */
  label?: string | null;
  /** path → file. A new artifact needs index.html (a doc may send index.md). On an update, null removes a path and every unlisted path carries over. */
  files: Record<string, ArtifactFileInput | null>;
  /** The version you edited; a newer current version fails with 409 `version_conflict`. */
  base_version?: number;
  /** Fold this save into the current version when you published it less than 10 minutes ago (autosave). */
  amend?: boolean;
}

export interface UpdateArtifactInput {
  title?: string;
  description?: string | null;
  icon?: string | null;
  type?: ArtifactType;
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

export async function getArtifact(projectId: string, artifactId: string, options: { version?: number } = {}) {
  return unwrap(await backendApi.get<ArtifactDetail>(`${base(projectId)}/${artifactId}${query(options)}`));
}

export async function createArtifact(projectId: string, input: PublishArtifactInput) {
  return unwrap(await backendApi.post<ArtifactDetail>(base(projectId), input));
}

/** Publish a new version of an artifact. */
export async function publishArtifactVersion(projectId: string, artifactId: string, input: Omit<PublishArtifactInput, 'visibility'>) {
  return unwrap(await backendApi.put<ArtifactDetail>(`${base(projectId)}/${artifactId}`, input));
}

/** Rename, retype or share. */
export async function updateArtifact(projectId: string, artifactId: string, input: UpdateArtifactInput) {
  return unwrap(await backendApi.patch<Artifact>(`${base(projectId)}/${artifactId}`, input));
}

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

/** Restore an old version as a new current version. */
export async function restoreArtifactVersion(projectId: string, artifactId: string, version: number) {
  return unwrap(await backendApi.post<ArtifactDetail>(`${base(projectId)}/${artifactId}/restore`, { version }));
}

/** One file's source as stored (no kit), default index.html of the current version. */
export async function readArtifactFile(
  projectId: string,
  artifactId: string,
  options: { path?: string; version?: number; signal?: AbortSignal } = {},
): Promise<Blob> {
  const url = `${stripTrailingSlashes(platformConfig().backendUrl)}${base(projectId)}/${artifactId}/content${query({ path: options.path, version: options.version })}`;
  const response = await authenticatedFetch(url, { signal: options.signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(body?.error || body?.message || 'Could not read the artifact', { status: response.status });
  }
  return response.blob();
}
