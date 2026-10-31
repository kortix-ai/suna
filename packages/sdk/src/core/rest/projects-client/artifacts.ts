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
import type { SessionParticipants } from './sessions';
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
  /** The space it is grouped in (see `ResourceBinding`), or null. Older servers omit it. */
  space?: string | null;
  /** The agent that owns it: by default the agent of the session that published it. Older servers omit it. */
  agent?: string | null;
  created_at: string;
  updated_at: string;
}

/** Where an artifact is grouped. Grouping only: it grants nothing. Null clears a field. */
export interface ArtifactBindingInput {
  /** A space slug. */
  space?: string | null;
  /** An agent name. Default on publish/share from a session: that session's agent. */
  agent?: string | null;
}

export interface ListArtifactsOptions {
  scope?: ArtifactListScope;
  type?: ArtifactType;
  q?: string;
  limit?: number;
  /** Only artifacts in this space. With `agents`: bound to the space, or unbound to a space and owned by one of `agents`. */
  space?: string;
  /** The agents of `space` (`agentsInSpace`), so the server needs no manifest. */
  agents?: string[];
  /** Only artifacts with no space and no agent (project-wide). */
  unbound?: boolean;
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
  /** Who can open it, owner first, in a session's participants shape. Only on a read (`getArtifact`). */
  participants?: SessionParticipants;
}

export type ArtifactCommentStatus = 'open' | 'resolved';
export type ArtifactCommentAuthor =
  | { kind: 'user'; user_id: string; name: string }
  | { kind: 'session'; session_id: string; agent_name: string; title: string | null };

export type ArtifactCommentMention =
  | { kind: 'user'; user_id: string }
  | { kind: 'session'; session_id: string; agent_name: string; token?: string }
  | { kind: 'agent'; agent_name: string; token?: string };

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

export interface ArtifactCommentMark {
  tool: "pen" | "arrow" | "rectangle";
  color: "black" | "red" | "blue";
  points: Array<{ x: number; y: number }>;
  /** Stroke width relative to the region width, 0.001–0.05. */
  width: number;
}

/** Validate stored marks without changing the published unknown[] response type. */
export function parseArtifactCommentMarks(
  value: unknown,
): ArtifactCommentMark[] | null {
  try {
    if (!Array.isArray(value) || value.length > 64) return null;
    const marks: ArtifactCommentMark[] = [];
    let total = 0;
    for (const mark of value) {
      if (
        !mark ||
        typeof mark !== "object" ||
        Array.isArray(mark) ||
        Object.keys(mark).some(
          (key) => !["tool", "color", "points", "width"].includes(key),
        )
      )
        return null;
      if (
        !["pen", "arrow", "rectangle"].includes(mark.tool) ||
        !["black", "red", "blue"].includes(mark.color) ||
        !Number.isFinite(mark.width) ||
        mark.width < 0.001 ||
        mark.width > 0.05 ||
        !Array.isArray(mark.points)
      )
        return null;
      if (
        mark.points.length < 2 ||
        mark.points.length > (mark.tool === "pen" ? 1024 : 2) ||
        (total += mark.points.length) > 8192
      )
        return null;
      const points: Array<{ x: number; y: number }> = [];
      for (const point of mark.points) {
        if (
          !point ||
          typeof point !== "object" ||
          Array.isArray(point) ||
          Object.keys(point).some((key) => key !== "x" && key !== "y") ||
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          point.x < 0 ||
          point.x > 1 ||
          point.y < 0 ||
          point.y > 1
        )
          return null;
        points.push({ x: point.x, y: point.y });
      }
      if (
        mark.tool !== "pen" &&
        points[0].x === points[1].x &&
        points[0].y === points[1].y
      )
        return null;
      marks.push({
        tool: mark.tool,
        color: mark.color,
        width: mark.width,
        points,
      });
    }
    return marks;
  } catch {
    return null;
  }
}

export interface ArtifactComment {
  comment_id: string;
  thread_id: string;
  author_user_id: string | null;
  author_session_id: string | null;
  author: ArtifactCommentAuthor;
  body: string;
  mentions: ArtifactCommentMention[];
  marks: unknown[];
  screenshot_key: string | null;
  /** Protected API path; read with readArtifactCommentScreenshot. */
  screenshot_url?: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  /** Authoritative action permissions; absent from older APIs. */
  can_edit?: boolean;
  can_delete?: boolean;
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
  /** A bounded delivery failure; null for the loop guard. Absent from older APIs. */
  agent_error?: string | null;
  sent_session_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  comments: ArtifactComment[];
  outdated: boolean;
  position: { start: number; end: number } | null;
  /** Historical reads return false for both actions. Absent from older APIs. */
  can_reply?: boolean;
  can_resolve?: boolean;
}

export interface ArtifactCommentContext {
  can_comment: boolean;
  can_moderate: boolean;
  comment_count: number;
  /** Total eligible threads. One Send request contains at most the first 100 IDs. */
  send_thread_count: number;
  send_thread_ids: string[];
  people: Array<{ user_id: string; name: string; avatar_url: string | null; token: string }>;
  agents: Array<{ agent_name: string; name: string; session_id: string | null; token: string }>;
  send_target: { kind: 'session' | 'new'; session_id: string | null; agent_name: string } | null;
  version: { commit_id: string | null; entry_version: string | null };
}

export interface ArtifactCommentSnapshot {
  /** Immutable Files history commit, distinct from an entry ETag. */
  version: string;
  text: string;
}

export interface CreateArtifactCommentInput {
  /** Text quotes and their prefix/suffix are at most 32 UTF-16 code units each. */
  anchor: ArtifactCommentAnchor;
  body: string;
  marks?: ArtifactCommentMark[];
  screenshot_base64?: string;
}

export interface ArtifactCommentBodyInput { body: string }

export interface ReplyArtifactCommentInput extends ArtifactCommentBodyInput {
  marks?: ArtifactCommentMark[];
  screenshot_base64?: string;
}

export interface SendArtifactCommentsInput {
  thread_ids: string[];
  /** Reuse this id when retrying one handoff. The SDK generates it when omitted. */
  batch_id?: string;
  agent?: string;
}

export interface SendArtifactCommentsResult {
  session_id: string;
  created: boolean;
}

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

export interface PublishArtifactInput extends ArtifactBindingInput {
  title?: string;
  description?: string | null;
  /** Default private. */
  visibility?: ArtifactVisibility;
  /** path → file. `index.md` makes a doc, `index.html` a page. Stored in your folder in Files. */
  files: Record<string, ArtifactFileInput>;
}

export interface ShareArtifactPathInput extends ArtifactBindingInput {
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

export interface UpdateArtifactInput extends ArtifactBindingInput {
  title?: string;
  description?: string | null;
  visibility?: ArtifactVisibility;
  /** People who may view a private artifact. Replaces the list. */
  shared_with_user_ids?: string[];
}

const base = (projectId: string) => `/projects/${projectId}/artifacts`;

export async function listArtifactComments(projectId: string, artifactId: string, options: { status?: ArtifactCommentStatus | 'all'; version?: string } = {}) {
  return unwrap(await backendApi.get<{ threads: ArtifactCommentThread[] }>(`${base(projectId)}/${artifactId}/comments${query(options)}`)).threads;
}

/** Current permissions, literal mention tokens, and the proposed Send target. Historical contexts are read-only. */
export async function getArtifactCommentContext(projectId: string, artifactId: string, options: { version?: string; agent?: string } = {}) {
  return unwrap(await backendApi.get<ArtifactCommentContext>(`${base(projectId)}/${artifactId}/comments/context${query(options)}`));
}

/** Read the exact saved text a selection anchor identifies. Never substitutes an entry ETag for its commit. */
export async function readArtifactCommentSnapshot(projectId: string, artifactId: string, options: { version?: string } = {}): Promise<ArtifactCommentSnapshot> {
  const context = await getArtifactCommentContext(projectId, artifactId, options);
  const version = context.version.commit_id;
  if (!version) throw new ApiError('The Artifact has no saved comment version', { status: 404, code: 'artifact_comment_snapshot_unavailable' });
  return { version, text: await (await readArtifactFile(projectId, artifactId, { version })).text() };
}

/** Resolve a thread id without scanning a project's Artifacts. Visibility still applies. */
export async function getArtifactCommentThread(projectId: string, threadId: string) {
  return unwrap(await backendApi.get<{ thread: ArtifactCommentThread }>(`/projects/${projectId}/artifact-comment-threads/${threadId}`)).thread;
}

export async function createArtifactComment(projectId: string, artifactId: string, input: CreateArtifactCommentInput) {
  return unwrap(await backendApi.post<{ thread: ArtifactCommentThread }>(`${base(projectId)}/${artifactId}/comments`, input)).thread;
}

export async function replyArtifactComment(projectId: string, artifactId: string, threadId: string, input: ReplyArtifactCommentInput) {
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

/** Send selected threads. A newly reserved session stays pending until its queued creation completes. */
export async function sendArtifactComments(projectId: string, artifactId: string, input: SendArtifactCommentsInput) {
  const body = { ...input, batch_id: input.batch_id ?? crypto.randomUUID() };
  return unwrap(await backendApi.post<SendArtifactCommentsResult>(`${base(projectId)}/${artifactId}/comments/send`, body));
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

export async function listArtifacts(projectId: string, options: ListArtifactsOptions = {}) {
  const { agents, unbound, ...rest } = options;
  const search = new URLSearchParams(query(rest).slice(1));
  for (const agent of agents ?? []) search.append('agent', agent);
  if (unbound) search.set('unbound', '1');
  const text = search.toString();
  return unwrap(await backendApi.get<{ artifacts: Artifact[] }>(`${base(projectId)}${text ? `?${text}` : ''}`)).artifacts;
}

/** A web page as a doc's link card shows it. Nulls where the page says nothing (or could not be read). */
export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  /** The page's og:image, https only. */
  image_url: string | null;
}

/**
 * Read a web page's title, description and image, through the API (a browser
 * cannot read another site's page). Public addresses only; a page that cannot
 * be read answers nulls.
 */
export async function getLinkPreview(projectId: string, url: string) {
  return unwrap(await backendApi.get<LinkPreview>(`/projects/${projectId}/link-preview?url=${encodeURIComponent(url)}`));
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


/** Read a private screenshot through the authenticated API on every request. */
export async function readArtifactCommentScreenshot(
  projectId: string,
  artifactId: string,
  commentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const url = `${stripTrailingSlashes(platformConfig().backendUrl)}${base(projectId)}/${artifactId}/comments/${encodeURIComponent(commentId)}/screenshot`;
  const response = await authenticatedFetch(url, { signal: options.signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    throw new ApiError(body?.error || "Could not read the comment screenshot", {
      status: response.status,
      code: body?.code,
      details: body,
      data: body,
      response,
    });
  }
  return response.blob();
}
