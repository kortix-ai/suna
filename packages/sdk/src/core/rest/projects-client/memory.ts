// Memory pages — `/v1/projects/:id/memory/*` (apps/api/src/projects/routes/project-memory.ts).
// A layer is the project's Company memory (key `company`), one channel's or
// one DM's memory (key = the space id). A layer holds pages of 4 types plus
// `note`s: Remember-box sentences an agent has not filed yet. Every route
// answers 403 `feature_disabled` while the project's `project_channels` flag
// is off. Every call passes `showErrors: false`: the caller shows the error,
// and a rejection is an `ApiError` whose `code` names it (`version_conflict`,
// `title_taken`, `page_limit`, `layer_read_only`, `page_too_large`,
// `secret_detected`, `superseded`, `already_undone`, `memory_not_found`).
// The types carry the same fields as `@kortix/api-contract/memory`
// (held equal by `src/contract-drift.test.ts`).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** `company`, or the space id of a channel or DM. */
export type ProjectMemoryLayerKey = string;
export type ProjectMemoryLayerScope = 'company' | 'channel' | 'dm';
/** The 4 types a person or agent files a page as. */
export type ProjectMemoryFiledPageType = 'people' | 'decisions' | 'workstreams' | 'playbooks';
/** Every page type: the 4 filed types and `note`. */
export type ProjectMemoryPageType = ProjectMemoryFiledPageType | 'note';
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

export interface ProjectMemoryAuthor {
  kind: 'person' | 'agent' | 'system';
  /** The person, or the person an agent wrote for. */
  user_id: string | null;
  /** Display name or email; null when unknown. */
  name: string | null;
  /** The agent name, for `kind: agent`. */
  agent: string | null;
}

/** The thread a change came from; `label` is its title at write time. */
export interface ProjectMemoryThreadRef {
  session_id: string;
  label: string;
}

/** A numbered source of a page; the body cites it as the token ⟦n⟧. */
export interface ProjectMemorySource {
  number: number;
  kind: ProjectMemorySourceKind;
  session_id: string | null;
  message_id: string | null;
  label: string;
  /** `outside` sources only. */
  url: string | null;
  /** Where the source thread lives, so a host can build its link; null when the thread or its space is gone. */
  thread_href_hint: { space_kind: 'channel'; slug: string } | { space_kind: 'dm'; agent: string } | null;
}

export interface ProjectMemoryLayer {
  layer_id: string;
  scope: ProjectMemoryLayerScope;
  /** Null for the Company layer. */
  space_id: string | null;
  /** "Company", "#marketing", or the DM's agent name. */
  name: string;
  /** Live pages per type; `unconfirmed` and `trash` count across types. */
  counts: {
    people: number;
    decisions: number;
    workstreams: number;
    playbooks: number;
    note: number;
    unconfirmed: number;
    trash: number;
  };
  /** An archived channel's layer: every write rejects with 409 `layer_read_only`. */
  read_only: boolean;
  can_write: boolean;
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
}

export interface ProjectMemoryPage extends ProjectMemoryPageSummary {
  /** Markdown; `## ` headings make sections, ⟦n⟧ cites `sources` number n. */
  body: string;
  sources: ProjectMemorySource[];
  related: { page_id: string; title: string }[];
  /** Send it back as `base_version` on update. */
  version_no: number;
  can_edit: boolean;
  can_delete: boolean;
}

/** One row of Recent changes. */
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

/** One page of Recent changes or of a page's history. */
export interface ProjectMemoryPageOptions {
  /** Rows per page; the API caps it. */
  limit?: number;
  /** The `next` of the previous page. */
  before?: string;
}

export interface CreateProjectMemoryPageInput {
  type: ProjectMemoryFiledPageType;
  /** 1–120 characters. */
  title: string;
  /** At most 200 characters, one line. */
  summary?: string;
  /** Markdown, at most 8,192 UTF-8 bytes (else 413 `page_too_large`). */
  body?: string;
  /** Page ids, at most 10. */
  related?: string[];
}

export interface UpdateProjectMemoryPageInput {
  /** The `version_no` the edit started from; another version rejects with 409 `version_conflict`. */
  base_version: number;
  title?: string;
  type?: ProjectMemoryFiledPageType;
  summary?: string;
  body?: string;
  related?: string[];
}

/** A Remember-box sentence, saved as a `note` page. */
export interface AddProjectMemoryNoteInput {
  /** 1–1,000 characters. */
  text: string;
  /** The thread the sentence was saved from. */
  source_session_id?: string;
  source_message_id?: string;
}

/** What `deleteProjectMemoryPage` resolves: `version_id` is the delete, for `undoProjectMemoryVersion`. */
export interface ProjectMemoryDeleteResult {
  ok: true;
  version_id: string;
}

/** What `undoProjectMemoryVersion` resolves: every live page the undo changed (both pages of a filed note); empty when it removed a page it had created. */
export interface ProjectMemoryUndoResult {
  pages: ProjectMemoryPage[];
}

/**
 * What the agent's `remember` tool returns (the tool result a thread shows as
 * "Saved to memory"). Hosts read it from the transcript; there is no SDK call:
 * only a session token may write through `remember`.
 */
export interface ProjectMemoryRememberResult {
  saved: true;
  page_id: string;
  /** Pass it to `undoProjectMemoryVersion`. */
  version_id: string;
  layer: {
    layer_id: string;
    /** The layer version, as decimal text. */
    version: string;
    scope: ProjectMemoryLayerScope;
    name: string;
    key: ProjectMemoryLayerKey;
  };
  title: string;
  status: ProjectMemoryPageStatus;
  /** A new page was made. */
  created: boolean;
  /** The fact went into an existing page. */
  merged: boolean;
  /** The page's file in the agent's read-only copy; null when the page has none. */
  copy_path: string | null;
}

const memory = (projectId: string) => `/projects/${projectId}/memory`;
const layer = (projectId: string, layerKey: ProjectMemoryLayerKey) => `${memory(projectId)}/layers/${layerKey}`;
const page = (projectId: string, pageId: string) => `${memory(projectId)}/pages/${pageId}`;
const quiet = { showErrors: false } as const;

function paged(path: string, options?: ProjectMemoryPageOptions): string {
  const query = new URLSearchParams();
  if (options?.limit !== undefined) query.set('limit', String(options.limit));
  if (options?.before) query.set('before', options.before);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** One layer with its page counts; the first read creates it. Another member's DM rejects with 404 `memory_not_found`. A background read. */
export async function getProjectMemoryLayer(projectId: string, layerKey: ProjectMemoryLayerKey): Promise<ProjectMemoryLayer> {
  return unwrap(await backendApi.get<ProjectMemoryLayer>(layer(projectId, layerKey), quiet));
}

/** The layer's live pages (at most 200), without bodies. A background read. */
export async function listProjectMemoryPages(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
): Promise<ProjectMemoryPageSummary[]> {
  const body = unwrap(await backendApi.get<{ pages: ProjectMemoryPageSummary[] }>(`${layer(projectId, layerKey)}/pages`, quiet));
  return body.pages;
}

/**
 * Create a page. Rejects with 409 `title_taken` (`data.page_id` names the
 * live page with that title), 409 `page_limit` (200 live pages),
 * 409 `layer_read_only`, 413 `page_too_large` or 422 `secret_detected`.
 */
export async function createProjectMemoryPage(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  input: CreateProjectMemoryPageInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.post<ProjectMemoryPage>(`${layer(projectId, layerKey)}/pages`, input, quiet));
}

/** Save a Remember-box sentence as a `note` page. Rejects as `createProjectMemoryPage` does. */
export async function addProjectMemoryNote(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  input: AddProjectMemoryNoteInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.post<ProjectMemoryPage>(`${layer(projectId, layerKey)}/notes`, input, quiet));
}

/** One page of the layer's Recent changes, newest first; walk older pages with `next` → `before`. A background read. */
export async function listProjectMemoryChanges(
  projectId: string,
  layerKey: ProjectMemoryLayerKey,
  options?: ProjectMemoryPageOptions,
): Promise<ProjectMemoryChangeList> {
  return unwrap(
    await backendApi.get<ProjectMemoryChangeList>(paged(`${layer(projectId, layerKey)}/changes`, options), quiet),
  );
}

/** One page with its body and sources. A background read. */
export async function getProjectMemoryPage(projectId: string, pageId: string): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.get<ProjectMemoryPage>(page(projectId, pageId), quiet));
}

/**
 * Edit a page. `base_version` is the `version_no` the edit started from: a
 * newer version rejects with 409 `version_conflict`. Also 409 `title_taken`,
 * 409 `layer_read_only`, 413 `page_too_large`, 422 `secret_detected`.
 */
export async function updateProjectMemoryPage(
  projectId: string,
  pageId: string,
  input: UpdateProjectMemoryPageInput,
): Promise<ProjectMemoryPage> {
  return unwrap(await backendApi.patch<ProjectMemoryPage>(page(projectId, pageId), input, quiet));
}

/** Move a page to the trash. Without `can_delete` it rejects with 403 `forbidden`. */
export async function deleteProjectMemoryPage(projectId: string, pageId: string): Promise<ProjectMemoryDeleteResult> {
  return unwrap(await backendApi.delete<ProjectMemoryDeleteResult>(page(projectId, pageId), quiet));
}

/** One page of the page's versions, newest first; walk older ones with `next` → `before`. A background read. */
export async function listProjectMemoryHistory(
  projectId: string,
  pageId: string,
  options?: ProjectMemoryPageOptions,
): Promise<ProjectMemoryVersionList> {
  return unwrap(
    await backendApi.get<ProjectMemoryVersionList>(paged(`${page(projectId, pageId)}/history`, options), quiet),
  );
}

/** Make an older version the page's content again (a new version). Rejects with 409 `page_limit` or `title_taken`. */
export async function restoreProjectMemoryPage(
  projectId: string,
  pageId: string,
  versionId: string,
): Promise<ProjectMemoryPage> {
  return unwrap(
    await backendApi.post<ProjectMemoryPage>(`${page(projectId, pageId)}/restore`, { version_id: versionId }, quiet),
  );
}

/**
 * Undo one change: every version row with the same `change_id` (both pages of
 * a filed note); resolves every page it changed. A page changed again since rejects with 409 `superseded`; a
 * second undo rejects with 409 `already_undone`.
 */
export async function undoProjectMemoryVersion(projectId: string, versionId: string): Promise<ProjectMemoryUndoResult> {
  return unwrap(
    await backendApi.post<ProjectMemoryUndoResult>(`${memory(projectId)}/versions/${versionId}/undo`, undefined, quiet),
  );
}
