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
  /** 1 for the oldest save the history returns. */
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

export type ArtifactCommentStatus = 'open' | 'resolved';
export type ArtifactCommentAuthor =
  | { kind: 'user'; user_id: string; name: string }
  | { kind: 'session'; session_id: string; agent_name: string; title: string | null };

export type ArtifactCommentAnchor =
  | { type: 'none'; version: string }
  | { type: 'text'; version: string; quote: string; prefix: string; suffix: string }
  | {
    type: 'point'; version: string; selector: string; snippet: string; viewport_width: number;
    scroll: { x: number; y: number }; offset: { x: number; y: number };
  }
  | {
    type: 'region'; version: string; selector: string; snippet: string; viewport_width: number;
    scroll: { x: number; y: number }; offset: { x: number; y: number; width: number; height: number };
  };

export interface ArtifactComment {
  comment_id: string;
  thread_id: string;
  author_user_id: string | null;
  author_session_id: string | null;
  author: ArtifactCommentAuthor;
  body: string;
  mentions: unknown[];
  marks: unknown[];
  screenshot_key: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface ArtifactCommentThread {
  thread_id: string;
  artifact_id: string;
  project_id: string;
  anchor: ArtifactCommentAnchor;
  anchor_version: string;
  created_by_user_id: string | null;
  created_by_session_id: string | null;
  status: ArtifactCommentStatus;
  resolved_by_user_id: string | null;
  resolved_by_session_id: string | null;
  resolved_at: string | null;
  agent_state: 'none' | 'pending' | 'sent' | 'paused';
  sent_session_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  comments: ArtifactComment[];
  outdated: boolean;
  position: { start: number; end: number } | null;
}

export interface CreateArtifactCommentInput {
  /** Text quotes and their prefix/suffix are at most 32 UTF-16 code units each. */
  anchor: ArtifactCommentAnchor;
  body: string;
}

export interface ArtifactCommentBodyInput { body: string }

export interface ArtifactActivityItem {
  id: string;
  type: 'saved' | 'published' | 'renamed' | 'visibility_changed' | 'shared_with_changed' | 'restored'
    | 'thread_opened' | 'replied' | 'resolved' | 'reopened' | 'comment_deleted' | 'sent_to_agent';
  at: string;
  actor: { kind: 'user' | 'session'; id: string; name: string } | { kind: 'system'; id: null; name: string };
  data: Record<string, unknown>;
}

export interface ArtifactActivityPage {
  items: ArtifactActivityItem[];
  next_cursor: string | null;
  /** The Files history reached its 100-commit limit; older saves can be unavailable. */
  older_versions: boolean;
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

export async function listArtifactComments(projectId: string, artifactId: string, options: { status?: ArtifactCommentStatus | 'all' } = {}) {
  return unwrap(await backendApi.get<{ threads: ArtifactCommentThread[] }>(`${base(projectId)}/${artifactId}/comments${query(options)}`)).threads;
}

/** Resolve a thread id without scanning a project's Artifacts. Visibility still applies. */
export async function getArtifactCommentThread(projectId: string, threadId: string) {
  return unwrap(await backendApi.get<{ thread: ArtifactCommentThread }>(`/projects/${projectId}/artifact-comment-threads/${threadId}`)).thread;
}

export async function createArtifactComment(projectId: string, artifactId: string, input: CreateArtifactCommentInput) {
  return unwrap(await backendApi.post<{ thread: ArtifactCommentThread }>(`${base(projectId)}/${artifactId}/comments`, input)).thread;
}

export async function replyArtifactComment(projectId: string, artifactId: string, threadId: string, input: ArtifactCommentBodyInput) {
  return unwrap(await backendApi.post<{ comment: ArtifactComment }>(`${base(projectId)}/${artifactId}/comments/${threadId}/replies`, input)).comment;
}

export async function setArtifactCommentStatus(projectId: string, artifactId: string, threadId: string, status: ArtifactCommentStatus) {
  return unwrap(await backendApi.patch<{ thread: ArtifactCommentThread }>(`${base(projectId)}/${artifactId}/comments/${threadId}`, { status })).thread;
}

export async function editArtifactComment(projectId: string, artifactId: string, threadId: string, commentId: string, input: ArtifactCommentBodyInput) {
  return unwrap(await backendApi.patch<{ comment: ArtifactComment }>(`${base(projectId)}/${artifactId}/comments/${threadId}/${commentId}`, input)).comment;
}

export async function deleteArtifactComment(projectId: string, artifactId: string, threadId: string, commentId: string) {
  return unwrap(await backendApi.delete<{ comment: ArtifactComment }>(`${base(projectId)}/${artifactId}/comments/${threadId}/${commentId}`)).comment;
}

export async function listArtifactActivity(projectId: string, artifactId: string, options: { limit?: number; cursor?: string } = {}) {
  return unwrap(await backendApi.get<ArtifactActivityPage>(`${base(projectId)}/${artifactId}/activity${query(options)}`));
}

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
