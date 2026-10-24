// Memory — `/v1/projects/:id/memory/*` (apps/api/src/projects/routes/project-memory.ts).
// Memory is the Markdown files of the project's Drive. A layer is one folder:
// the project's Company memory (key `company`, `/Company/Memory`), one
// channel's (key = the space id, `/Company/Channels/<slug>/Memory`) or one
// DM's (key = the space id: the owner's `/Users/<person>/Memory`, its agent
// folder `Memory/<agent>` first). A page is one file. Agents read and write
// the same files through their mounts. Every route answers 403
// `feature_disabled` while the project's Files (`drives`) are off, and 503
// `drive_storage_unavailable` without Drive storage. Every call passes
// `showErrors: false`: the caller shows the error, and a rejection is an
// `ApiError` whose `code` names it (`version_conflict`, `title_taken`,
// `layer_read_only`, `page_too_large`, `secret_detected`, `superseded`,
// `version_gone`, `memory_not_found`, `invalid_input`, `session_not_found`,
// `forbidden`).
// The types carry the same fields as `@kortix/api-contract/memory`
// (held equal by `src/contract-drift.test.ts`).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** `company`, or the space id of a channel or DM. */
export type ProjectMemoryLayerKey = string;
export type ProjectMemoryLayerScope = 'company' | 'channel' | 'dm';
/** The 4 typed folders a page can live in. */
export type ProjectMemoryFiledPageType = 'people' | 'decisions' | 'workstreams' | 'playbooks';
/** Every page type: the 4 filed types, `note` (a `Notes.md`) and `other` (any other Markdown file). */
export type ProjectMemoryPageType = ProjectMemoryFiledPageType | 'note' | 'other';
/** Always `confirmed`: files have no pending state. */
export type ProjectMemoryPageStatus = 'confirmed' | 'unconfirmed';
export type ProjectMemoryChangeOp =
  | 'create'
  | 'update'
  | 'append'
  | 'delete'
  | 'restore'
  | 'undo'
  | 'confirm'
  | 'file_note'
  | 'import';
export type ProjectMemorySourceKind = 'thread' | 'person' | 'outside' | 'import';

/** Who last changed a page: the file's front-matter `updated_by`, else `system`. */
export interface ProjectMemoryAuthor {
  kind: 'person' | 'agent' | 'system';
  /** Always null for files: front-matter names people by name. */
  user_id: string | null;
  /** Display name; null when unknown. */
  name: string | null;
  /** The agent name, for `kind: agent`. */
  agent: string | null;
}

/** The thread a change came from. Always null for files; kept for the shape. */
export interface ProjectMemoryThreadRef {
  session_id: string;
  label: string;
}

/** A numbered source of a page, from the file's front-matter `sources:` (1-based, in file order). */
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

export interface ProjectMemoryLayer {
  /** The layer key (`company` or the space id). */
  layer_id: string;
  scope: ProjectMemoryLayerScope;
  /** Null for the Company layer. */
  space_id: string | null;
  /** "Company", "#marketing", or the DM's agent name. */
  name: string;
  /** Pages per type. `unconfirmed` and `trash` are always 0 (no pending state, no trash). */
  counts: {
    people: number;
    decisions: number;
    workstreams: number;
    playbooks: number;
    note: number;
    other: number;
    unconfirmed: number;
    trash: number;
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

/** A page in the layer's list: no body. */
export interface ProjectMemoryPageSummary {
  page_id: string;
  layer_id: string;
  type: ProjectMemoryPageType;
  title: string;
  summary: string;
  status: ProjectMemoryPageStatus;
  updated_at: string;
  updated_by: ProjectMemoryAuthor;
  updated_source: ProjectMemoryThreadRef | null;
  /** The file, a Drive path. */
  path: string;
}

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

/** One row of Recent changes: a recently changed file. */
export interface ProjectMemoryChange {
  version_id: string;
  /** Shared by every row one change wrote (both pages of a `file_note`); Undo reverts them all. */
  change_id: string;
  page_id: string;
  page_title: string;
  op: ProjectMemoryChangeOp;
  author: ProjectMemoryAuthor;
  source: ProjectMemoryThreadRef | null;
  created_at: string;
  undone: boolean;
  can_undo: boolean;
}

export interface ProjectMemoryChangeList {
  /** Newest first. */
  changes: ProjectMemoryChange[];
  /** Pass it as `before` for the next older page; null on the last page. */
  next: string | null;
}

/** One entry of a page's history: the page as it was after that change. */
export interface ProjectMemoryVersion {
  version_id: string;
  change_id: string;
  version_no: number;
  op: ProjectMemoryChangeOp;
  author: ProjectMemoryAuthor;
  source: ProjectMemoryThreadRef | null;
  created_at: string;
  undone: boolean;
  can_undo: boolean;
  snapshot: {
    type: ProjectMemoryPageType;
    title: string;
    summary: string;
    body: string;
    status: ProjectMemoryPageStatus;
    /** Page ids. */
    related: string[];
    deleted: boolean;
  };
}

export interface ProjectMemoryVersionList {
  /** Newest first. */
  versions: ProjectMemoryVersion[];
  /** Pass it as `before` for the next older page; null on the last page. */
  next: string | null;
}

/** Which pages `listProjectMemoryPages` lists. */
export interface ProjectMemoryPageListOptions {
  type?: ProjectMemoryPageType;
  /** `unconfirmed` lists nothing (files have no pending state). */
  status?: ProjectMemoryPageStatus;
}

/** One page of Recent changes or of a page's history. */
export interface ProjectMemoryPageOptions {
  /** Rows per page; the API caps it. */
  limit?: number;
  /** The `next` of the previous page. */
  before?: string;
}

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

/** The body only: front-matter and the `# ` title line are kept. */
export interface UpdateProjectMemoryPageInput {
  /** The `version_no` the edit started from; another version rejects with 409 `version_conflict`. */
  base_version: number;
  body: string;
}

/** A Remember-box sentence, appended to the layer's `Notes.md`. */
export interface AddProjectMemoryNoteInput {
  /** 1–1,000 characters. */
  text: string;
  /** The thread the sentence was saved from. */
  source_session_id?: string;
  source_message_id?: string;
}

/** What `deleteProjectMemoryPage` resolves. The file is deleted for good: `version_id` is the deleted page id, not undoable. */
export interface ProjectMemoryDeleteResult {
  ok: true;
  version_id: string;
}

/** What `undoProjectMemoryVersion` resolves: the page after the undo; empty when the undo deleted a file the change created. */
export interface ProjectMemoryUndoResult {
  pages: ProjectMemoryPage[];
}

/** One hit of `searchProjectMemory`. */
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
  status: ProjectMemoryPageStatus;
}

export interface ProjectMemorySearchResult {
  /** Best first. */
  hits: ProjectMemorySearchHit[];
}

export interface ProjectMemorySearchInput {
  /** 2–200 characters after trimming; shorter rejects with 400 `invalid_input`. */
  q: string;
  /** Search this one layer (`company` or a space id) only. */
  layer?: ProjectMemoryLayerKey;
  type?: ProjectMemoryPageType;
  /** 1–20; the API's default is 20. */
  limit?: number;
}

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

const memory = (projectId: string) => `/projects/${projectId}/memory`;
const layer = (projectId: string, layerKey: ProjectMemoryLayerKey) => `${memory(projectId)}/layers/${layerKey}`;
const page = (projectId: string, pageId: string) => `${memory(projectId)}/pages/${pageId}`;
const quiet = { showErrors: false } as const;

/** The `?limit=&before=` suffix, or ''. A suffix, not a wrapper, so the route-contract test resolves the path. */
function pageQuery(options?: ProjectMemoryPageOptions): string {
  const query = new URLSearchParams();
  if (options?.limit !== undefined) query.set('limit', String(options.limit));
  if (options?.before) query.set('before', options.before);
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** One layer: its Drive folder and page counts. Another member's DM rejects with 404 `memory_not_found`. A background read. */
export async function getProjectMemoryLayer(projectId: string, layerKey: ProjectMemoryLayerKey): Promise<ProjectMemoryLayer> {
  return unwrap(await backendApi.get<ProjectMemoryLayer>(layer(projectId, layerKey), quiet));
}

/**
 * The layer's pages, one per Markdown file, newest first (a DM's agent folder
 * first), without bodies, at most 500. A background read.
 */
export async function listProjectMemoryPages(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  options?: ProjectMemoryPageListOptions,
): Promise<ProjectMemoryPageSummary[]> {
  const query = new URLSearchParams();
  if (options?.type) query.set('type', options.type);
  if (options?.status) query.set('status', options.status);
  const text = query.toString();
  const suffix = text ? `?${text}` : '';
  const body = unwrap(
    await backendApi.get<{ pages: ProjectMemoryPageSummary[] }>(`${layer(projectId, layerKey)}/pages${suffix}`, quiet),
  );
  return body.pages;
}

/**
 * Create a page: writes `<folder>/<type>/<slug>.md` (`other`: `<folder>/<slug>.md`).
 * Rejects with 409 `title_taken` (`data.page_id` names the file that exists),
 * 409 `layer_read_only`, 413 `page_too_large` or 422 `secret_detected`.
 */
export async function createProjectMemoryPage(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  input: CreateProjectMemoryPageInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.post<ProjectMemoryPage>(`${layer(projectId, layerKey)}/pages`, input, quiet));
}

/** Append a Remember-box sentence to the layer's `Notes.md`; resolves that page. Rejects as `createProjectMemoryPage` does. */
export async function addProjectMemoryNote(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  input: AddProjectMemoryNoteInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.post<ProjectMemoryPage>(`${layer(projectId, layerKey)}/notes`, input, quiet));
}

/** The layer's Recent changes: its 20 most recently changed files, newest first (`next` is always null). A background read. */
export async function listProjectMemoryChanges(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  options?: ProjectMemoryPageOptions,
): Promise<ProjectMemoryChangeList> {
  return unwrap(
    await backendApi.get<ProjectMemoryChangeList>(`${layer(projectId, layerKey)}/changes${pageQuery(options)}`, quiet),
  );
}

/** One page with its body and sources. A background read. */
export async function getProjectMemoryPage(projectId: string, pageId: string): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.get<ProjectMemoryPage>(page(projectId, pageId), quiet));
}

/**
 * Replace a page's body (front-matter and the title line are kept).
 * `base_version` is the `version_no` the edit started from: a newer version
 * rejects with 409 `version_conflict`. Also 409 `layer_read_only`, 413
 * `page_too_large`, 422 `secret_detected`.
 */
export async function updateProjectMemoryPage(
  projectId: string,
  pageId: string,
  input: UpdateProjectMemoryPageInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.patch<ProjectMemoryPage>(page(projectId, pageId), input, quiet));
}

/** Delete a page's file for good. Without `can_delete` it rejects with 403 `forbidden`. */
export async function deleteProjectMemoryPage(projectId: string, pageId: string): Promise<ProjectMemoryDeleteResult> {
  return unwrap(await backendApi.delete<ProjectMemoryDeleteResult>(page(projectId, pageId), quiet));
}

/** The page's versions from the drive's newest 100 commits, newest first, at most 20 (`next` is always null). A background read. */
export async function listProjectMemoryHistory(
  projectId: string,
  pageId: string,
  options?: ProjectMemoryPageOptions,
): Promise<ProjectMemoryVersionList> {
  return unwrap(
    await backendApi.get<ProjectMemoryVersionList>(`${page(projectId, pageId)}/history${pageQuery(options)}`, quiet),
  );
}

/**
 * Undo the newest change of a page: the version before it is written back, or
 * the file is deleted when the change created it. An older version rejects
 * with 409 `superseded`; one the newest 100 Drive commits do not reach with 404 `version_gone`.
 */
export async function undoProjectMemoryVersion(projectId: string, versionId: string): Promise<ProjectMemoryUndoResult> {
  return unwrap(
    await backendApi.post<ProjectMemoryUndoResult>(`${memory(projectId)}/versions/${versionId}/undo`, undefined, quiet),
  );
}

/**
 * Search the pages a person can read: Company, every live channel and their
 * own Memory folder, or the one `layer`. Case-insensitive text over title and
 * body, title hits first. `q` under 2 characters rejects with 400
 * `invalid_input`. A background read.
 */
export async function searchProjectMemory(projectId: string, input: ProjectMemorySearchInput): Promise<ProjectMemorySearchResult> {
  const query = new URLSearchParams({ q: input.q });
  if (input.layer) query.set('layer', input.layer);
  if (input.type) query.set('type', input.type);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  return unwrap(await backendApi.get<ProjectMemorySearchResult>(`${memory(projectId)}/search?${query}`, quiet));
}

/**
 * A thread's "Used memory": the files listed to its agent at the first turn,
 * by layer. Files deleted since are left out. A thread the caller cannot open
 * rejects with 404 `session_not_found`. A background read.
 */
export async function getSessionMemoryUsage(projectId: string, sessionId: string): Promise<SessionMemoryUsage> {
  return unwrap(await backendApi.get<SessionMemoryUsage>(`/projects/${projectId}/sessions/${sessionId}/memory-usage`, quiet));
}
