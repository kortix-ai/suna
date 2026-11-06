// Memory — `/v1/projects/:id/memory/*` (apps/api/src/projects/routes/project-memory.ts).
// Memory is the Markdown files of the project's Drive. A layer is one folder:
// the project's Company memory (key `company`, `/Company/Memory`), one
// channel's (key = the space id, `/Company/Channels/<slug>/Memory`) or one
// DM's (key = the space id: the owner's `/Users/<person>/Memory`, its agent
// folder `Memory/<agent>` first), or the caller's My Kortix memory (key
// `mykortix`, their own `/Users/<person>/Memory/mykortix`). A page is one file. Agents read and write
// the same files through their mounts. Every route answers 403
// `feature_disabled` while the project's Files (`drives`) are off, and 503
// `drive_storage_unavailable` without Drive storage. Every call passes
// `showErrors: false`: the caller shows the error, and a rejection is an
// `ApiError` whose `code` names it (`version_conflict`, `title_taken`,
// `layer_read_only`, `page_too_large`, `secret_detected`,
// `memory_not_found`, `invalid_input`, `session_not_found`, `forbidden`).
// The types carry the same fields as `@kortix/api-contract/memory`
// (held equal by `src/contract-drift.test.ts`).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/**
 * `company`, `mykortix` (what My Kortix remembers about the caller), or the space id of a channel or DM.
 *
 * @deprecated Use `WorkspaceMemoryLayerKey`. Kept permanently.
 */
export type ProjectMemoryLayerKey = string;

/** The workspace name of {@link ProjectMemoryLayerKey}: the same type. */
export type WorkspaceMemoryLayerKey = ProjectMemoryLayerKey;
/** @deprecated Use `WorkspaceMemoryLayerScope`. Kept permanently. */
export type ProjectMemoryLayerScope = 'company' | 'channel' | 'dm';

/** The workspace name of {@link ProjectMemoryLayerScope}: the same type. */
export type WorkspaceMemoryLayerScope = ProjectMemoryLayerScope;
/**
 * The 4 typed folders a page can live in.
 *
 * @deprecated Use `WorkspaceMemoryFiledPageType`. Kept permanently.
 */
export type ProjectMemoryFiledPageType = 'people' | 'decisions' | 'workstreams' | 'playbooks';

/** The workspace name of {@link ProjectMemoryFiledPageType}: the same type. */
export type WorkspaceMemoryFiledPageType = ProjectMemoryFiledPageType;
/**
 * The 4 types of a page My Kortix keeps about one person (front-matter `type:`): `user` (who they
 * are), `feedback` (how they want the work done), `project` (what they work on), `reference` (where
 * something is).
 *
 * @deprecated Use `WorkspaceMemoryPersonPageType`. Kept permanently.
 */
export type ProjectMemoryPersonPageType = 'user' | 'feedback' | 'project' | 'reference';

/** The workspace name of {@link ProjectMemoryPersonPageType}: the same type. */
export type WorkspaceMemoryPersonPageType = ProjectMemoryPersonPageType;
/**
 * Every page type: the 4 filed types, the 4 person types, `note` (a `Notes.md`) and `other` (any other Markdown file).
 *
 * @deprecated Use `WorkspaceMemoryPageType`. Kept permanently.
 */
export type ProjectMemoryPageType = ProjectMemoryFiledPageType | ProjectMemoryPersonPageType | 'note' | 'other';

/** The workspace name of {@link ProjectMemoryPageType}: the same type. */
export type WorkspaceMemoryPageType = ProjectMemoryPageType;
/**
 * What a page version did to the file: created it, or changed it.
 *
 * @deprecated Use `WorkspaceMemoryChangeOp`. Kept permanently.
 */
export type ProjectMemoryChangeOp = 'create' | 'update';

/** The workspace name of {@link ProjectMemoryChangeOp}: the same type. */
export type WorkspaceMemoryChangeOp = ProjectMemoryChangeOp;
/** @deprecated Use `WorkspaceMemorySourceKind`. Kept permanently. */
export type ProjectMemorySourceKind = 'thread' | 'person' | 'outside' | 'import';

/** The workspace name of {@link ProjectMemorySourceKind}: the same type. */
export type WorkspaceMemorySourceKind = ProjectMemorySourceKind;

/**
 * Who last changed a page: the file's front-matter `updated_by`, else `system`.
 *
 * @deprecated Use `WorkspaceMemoryAuthor`. Kept permanently.
 */
export interface ProjectMemoryAuthor {
  kind: 'person' | 'agent' | 'system';
  /** Always null for files: front-matter names people by name. */
  user_id: string | null;
  /** Display name; null when unknown. */
  name: string | null;
  /** The agent name, for `kind: agent`. */
  agent: string | null;
}

/** The workspace name of {@link ProjectMemoryAuthor}: the same type. */
export type WorkspaceMemoryAuthor = ProjectMemoryAuthor;

/**
 * A numbered source of a page, from the file's front-matter `sources:` (1-based, in file order).
 *
 * @deprecated Use `WorkspaceMemorySource`. Kept permanently.
 */
export interface ProjectMemorySource {
  number: number;
  kind: ProjectMemorySourceKind;
  session_id: string | null;
  message_id: string | null;
  label: string;
  url: string | null;
  /** Always null for files. */
  thread_href_hint: { space_kind: 'channel'; slug: string } | { space_kind: 'dm'; agent: string } | null;
}

/** The workspace name of {@link ProjectMemorySource}: the same type. */
export type WorkspaceMemorySource = ProjectMemorySource;

/** @deprecated Use `WorkspaceMemoryLayer`. Kept permanently. */
export interface ProjectMemoryLayer {
  /** The layer key (`company` or the space id). */
  layer_id: string;
  scope: ProjectMemoryLayerScope;
  /** Null for the Company layer. */
  space_id: string | null;
  /** "Company", "#marketing", or the DM's agent name. */
  name: string;
  /** Pages per type. */
  counts: {
    people: number;
    decisions: number;
    workstreams: number;
    playbooks: number;
    /** My Kortix memory pages (APIs from 2026-10-30 on send these 4; older ones leave them out). */
    user?: number;
    feedback?: number;
    project?: number;
    reference?: number;
    note: number;
    other: number;
  };
  /** An archived channel's layer: every write rejects with 409 `layer_read_only`. */
  read_only: boolean;
  can_write: boolean;
  /** The layer's folder, a Drive path (`/Company/Memory`): "Open in Files". */
  folder: string;
  /** A DM layer's agent folder (`/Users/<person>/Memory/<agent>`); null for others. */
  agent_folder: string | null;
  drive_id: string;
  /** Files under the folder that are not pages (images, PDFs, …). */
  other_files: number;
}

/** The workspace name of {@link ProjectMemoryLayer}: the same type. */
export type WorkspaceMemoryLayer = ProjectMemoryLayer;

/**
 * A page in the layer's list: no body.
 *
 * @deprecated Use `WorkspaceMemoryPageSummary`. Kept permanently.
 */
export interface ProjectMemoryPageSummary {
  page_id: string;
  layer_id: string;
  type: ProjectMemoryPageType;
  title: string;
  summary: string;
  /** The page's opening as plain text (no Markdown, no title), at most 280 characters. */
  excerpt: string;
  updated_at: string;
  updated_by: ProjectMemoryAuthor;
  /** The file, a Drive path. */
  path: string;
}

/** The workspace name of {@link ProjectMemoryPageSummary}: the same type. */
export type WorkspaceMemoryPageSummary = ProjectMemoryPageSummary;

/** @deprecated Use `WorkspaceMemoryPage`. Kept permanently. */
export interface ProjectMemoryPage extends ProjectMemoryPageSummary {
  /** The file's Markdown without front-matter and without its first `# ` heading. */
  body: string;
  sources: ProjectMemorySource[];
  related: { page_id: string; title: string }[];
  /** The file's mtime in ms. Send it back as `base_version` on update. */
  version_no: number;
  can_edit: boolean;
  can_delete: boolean;
}

/** The workspace name of {@link ProjectMemoryPage}: the same type. */
export type WorkspaceMemoryPage = ProjectMemoryPage;

/**
 * One entry of a page's history: the file as it was at one Drive commit.
 *
 * @deprecated Use `WorkspaceMemoryVersion`. Kept permanently.
 */
export interface ProjectMemoryVersion {
  version_id: string;
  /** The commit time in ms. */
  version_no: number;
  op: ProjectMemoryChangeOp;
  author: ProjectMemoryAuthor;
  created_at: string;
  snapshot: {
    type: ProjectMemoryPageType;
    title: string;
    summary: string;
    body: string;
    /** Page ids. */
    related: string[];
    deleted: boolean;
  };
}

/** The workspace name of {@link ProjectMemoryVersion}: the same type. */
export type WorkspaceMemoryVersion = ProjectMemoryVersion;

/** @deprecated Use `WorkspaceMemoryVersionList`. Kept permanently. */
export interface ProjectMemoryVersionList {
  /** Newest first, at most 20. Older versions are in Files → Versions. */
  versions: ProjectMemoryVersion[];
}

/** The workspace name of {@link ProjectMemoryVersionList}: the same type. */
export type WorkspaceMemoryVersionList = ProjectMemoryVersionList;

/**
 * Which pages `listProjectMemoryPages` lists.
 *
 * @deprecated Use `WorkspaceMemoryPageListOptions`. Kept permanently.
 */
export interface ProjectMemoryPageListOptions {
  type?: ProjectMemoryPageType;
}

/** The workspace name of {@link ProjectMemoryPageListOptions}: the same type. */
export type WorkspaceMemoryPageListOptions = ProjectMemoryPageListOptions;

/** @deprecated Use `CreateWorkspaceMemoryPageInput`. Kept permanently. */
export interface CreateProjectMemoryPageInput {
  /** A typed folder, or `other` (a file at the layer's root). */
  type: ProjectMemoryFiledPageType | 'other';
  /** 1–120 characters. */
  title: string;
  /** At most 200 characters, one line. */
  summary?: string;
  /** Markdown, at most 262,144 UTF-8 bytes (else 413 `page_too_large`). */
  body?: string;
  /** Page ids of the same layer, at most 10. */
  related?: string[];
  /** DM layer only: `true` (default) writes into the agent folder, `false` into the person's shared Memory folder. */
  agent_folder?: boolean;
}

/** The workspace name of {@link CreateProjectMemoryPageInput}: the same type. */
export type CreateWorkspaceMemoryPageInput = CreateProjectMemoryPageInput;

/**
 * The body only: front-matter and the `# ` title line are kept.
 *
 * @deprecated Use `UpdateWorkspaceMemoryPageInput`. Kept permanently.
 */
export interface UpdateProjectMemoryPageInput {
  /** The `version_no` the edit started from; another version rejects with 409 `version_conflict`. */
  base_version: number;
  body: string;
}

/** The workspace name of {@link UpdateProjectMemoryPageInput}: the same type. */
export type UpdateWorkspaceMemoryPageInput = UpdateProjectMemoryPageInput;

/**
 * A Remember-box sentence, appended to the layer's `Notes.md`.
 *
 * @deprecated Use `AddWorkspaceMemoryNoteInput`. Kept permanently.
 */
export interface AddProjectMemoryNoteInput {
  /** 1–1,000 characters. */
  text: string;
  /** The thread the sentence was saved from. */
  source_session_id?: string;
  source_message_id?: string;
}

/** The workspace name of {@link AddProjectMemoryNoteInput}: the same type. */
export type AddWorkspaceMemoryNoteInput = AddProjectMemoryNoteInput;

/**
 * What `deleteProjectMemoryPage` resolves. The file is deleted for good: `version_id` is the deleted page id.
 *
 * @deprecated Use `WorkspaceMemoryDeleteResult`. Kept permanently.
 */
export interface ProjectMemoryDeleteResult {
  ok: true;
  version_id: string;
}

/** The workspace name of {@link ProjectMemoryDeleteResult}: the same type. */
export type WorkspaceMemoryDeleteResult = ProjectMemoryDeleteResult;

/**
 * One hit of `searchProjectMemory`.
 *
 * @deprecated Use `WorkspaceMemorySearchHit`. Kept permanently.
 */
export interface ProjectMemorySearchHit {
  page_id: string;
  layer_key: ProjectMemoryLayerKey;
  /** "Company", "#marketing", or the DM's agent name. */
  layer_name: string;
  scope: ProjectMemoryLayerScope;
  type: ProjectMemoryPageType;
  title: string;
  summary: string;
  /** Up to ~160 characters of the body around the first match. */
  snippet: string;
}

/** The workspace name of {@link ProjectMemorySearchHit}: the same type. */
export type WorkspaceMemorySearchHit = ProjectMemorySearchHit;

/** @deprecated Use `WorkspaceMemorySearchResult`. Kept permanently. */
export interface ProjectMemorySearchResult {
  /** Best first. */
  hits: ProjectMemorySearchHit[];
}

/** The workspace name of {@link ProjectMemorySearchResult}: the same type. */
export type WorkspaceMemorySearchResult = ProjectMemorySearchResult;

/** @deprecated Use `WorkspaceMemorySearchInput`. Kept permanently. */
export interface ProjectMemorySearchInput {
  /** 2–200 characters after trimming; shorter rejects with 400 `invalid_input`. */
  q: string;
  /** Search this one layer (`company` or a space id) only. */
  layer?: ProjectMemoryLayerKey;
  type?: ProjectMemoryPageType;
  /** 1–20; the API's default is 20. */
  limit?: number;
}

/** The workspace name of {@link ProjectMemorySearchInput}: the same type. */
export type WorkspaceMemorySearchInput = ProjectMemorySearchInput;

/** One layer of a thread's "Used memory": the pages listed to its agent. */
export interface SessionMemoryUsageLayer {
  layer_key: ProjectMemoryLayerKey;
  scope: ProjectMemoryLayerScope;
  name: string;
  pages: { page_id: string; type: ProjectMemoryPageType; title: string }[];
}

/** What `getSessionMemoryUsage` resolves. */
export interface SessionMemoryUsage {
  /** When the thread's first turn listed the pages; null before the first turn. */
  loaded_at: string | null;
  layers: SessionMemoryUsageLayer[];
}

const memory = (projectId: string) => `/workspaces/${projectId}/memory`;
const layer = (projectId: string, layerKey: ProjectMemoryLayerKey) => `${memory(projectId)}/layers/${layerKey}`;
const page = (projectId: string, pageId: string) => `${memory(projectId)}/pages/${pageId}`;
const quiet = { showErrors: false } as const;

/** One layer: its Drive folder and page counts. Another member's DM rejects with 404 `memory_not_found`. A background read. */
export async function getWorkspaceMemoryLayer(projectId: string, layerKey: ProjectMemoryLayerKey): Promise<ProjectMemoryLayer> {
  return unwrap(await backendApi.get<ProjectMemoryLayer>(layer(projectId, layerKey), quiet));
}

/** @deprecated Use `getWorkspaceMemoryLayer`. Kept permanently. */
export const getProjectMemoryLayer = getWorkspaceMemoryLayer;

/**
 * The layer's pages, one per Markdown file, newest first (a DM's agent folder
 * first), without bodies, at most 500. A background read.
 */
export async function listWorkspaceMemoryPages(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  options?: ProjectMemoryPageListOptions,
): Promise<ProjectMemoryPageSummary[]> {
  const suffix = options?.type ? `?type=${options.type}` : '';
  const body = unwrap(
    await backendApi.get<{ pages: ProjectMemoryPageSummary[] }>(`${layer(projectId, layerKey)}/pages${suffix}`, quiet),
  );
  return body.pages;
}

/** @deprecated Use `listWorkspaceMemoryPages`. Kept permanently. */
export const listProjectMemoryPages = listWorkspaceMemoryPages;

/**
 * Create a page: writes `<folder>/<type>/<slug>.md` (`other`: `<folder>/<slug>.md`).
 * Rejects with 409 `title_taken` (`data.page_id` names the file that exists),
 * 409 `layer_read_only`, 413 `page_too_large` or 422 `secret_detected`.
 */
export async function createWorkspaceMemoryPage(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  input: CreateProjectMemoryPageInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.post<ProjectMemoryPage>(`${layer(projectId, layerKey)}/pages`, input, quiet));
}

/** @deprecated Use `createWorkspaceMemoryPage`. Kept permanently. */
export const createProjectMemoryPage = createWorkspaceMemoryPage;

/** Append a Remember-box sentence to the layer's `Notes.md`; resolves that page. Rejects as `createProjectMemoryPage` does. */
export async function addWorkspaceMemoryNote(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  input: AddProjectMemoryNoteInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.post<ProjectMemoryPage>(`${layer(projectId, layerKey)}/notes`, input, quiet));
}

/** @deprecated Use `addWorkspaceMemoryNote`. Kept permanently. */
export const addProjectMemoryNote = addWorkspaceMemoryNote;

/** One page with its body and sources. A background read. */
export async function getWorkspaceMemoryPage(projectId: string, pageId: string): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.get<ProjectMemoryPage>(page(projectId, pageId), quiet));
}

/** @deprecated Use `getWorkspaceMemoryPage`. Kept permanently. */
export const getProjectMemoryPage = getWorkspaceMemoryPage;

/**
 * Replace a page's body (front-matter and the title line are kept).
 * `base_version` is the `version_no` the edit started from: a newer version
 * rejects with 409 `version_conflict`. Also 409 `layer_read_only`, 413
 * `page_too_large`, 422 `secret_detected`.
 */
export async function updateWorkspaceMemoryPage(
  projectId: string,
  pageId: string,
  input: UpdateProjectMemoryPageInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.patch<ProjectMemoryPage>(page(projectId, pageId), input, quiet));
}

/** @deprecated Use `updateWorkspaceMemoryPage`. Kept permanently. */
export const updateProjectMemoryPage = updateWorkspaceMemoryPage;

/** Delete a page's file for good. Without `can_delete` it rejects with 403 `forbidden`. */
export async function deleteWorkspaceMemoryPage(projectId: string, pageId: string): Promise<ProjectMemoryDeleteResult> {
  return unwrap(await backendApi.delete<ProjectMemoryDeleteResult>(page(projectId, pageId), quiet));
}

/** @deprecated Use `deleteWorkspaceMemoryPage`. Kept permanently. */
export const deleteProjectMemoryPage = deleteWorkspaceMemoryPage;

/** The page's versions from the drive's newest 100 commits, newest first, at most 20. A background read. */
export async function listWorkspaceMemoryHistory(projectId: string, pageId: string): Promise<ProjectMemoryVersionList> {
  return unwrap(await backendApi.get<ProjectMemoryVersionList>(`${page(projectId, pageId)}/history`, quiet));
}

/** @deprecated Use `listWorkspaceMemoryHistory`. Kept permanently. */
export const listProjectMemoryHistory = listWorkspaceMemoryHistory;

/**
 * Search the pages a person can read: Company, every live channel and their
 * own Memory folder, or the one `layer`. Case-insensitive text over title and
 * body, title hits first. `q` under 2 characters rejects with 400
 * `invalid_input`. A background read.
 */
export async function searchWorkspaceMemory(projectId: string, input: ProjectMemorySearchInput): Promise<ProjectMemorySearchResult> {
  const query = new URLSearchParams({ q: input.q });
  if (input.layer) query.set('layer', input.layer);
  if (input.type) query.set('type', input.type);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  return unwrap(await backendApi.get<ProjectMemorySearchResult>(`${memory(projectId)}/search?${query}`, quiet));
}

/** @deprecated Use `searchWorkspaceMemory`. Kept permanently. */
export const searchProjectMemory = searchWorkspaceMemory;

/**
 * A thread's "Used memory": the files listed to its agent at the first turn,
 * by layer. Files deleted since are left out. A thread the caller cannot open
 * rejects with 404 `session_not_found`. A background read.
 */
export async function getSessionMemoryUsage(projectId: string, sessionId: string): Promise<SessionMemoryUsage> {
  return unwrap(await backendApi.get<SessionMemoryUsage>(`/workspaces/${projectId}/sessions/${sessionId}/memory-usage`, quiet));
}
