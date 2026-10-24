// Project spaces — `/v1/projects/:id/spaces` (apps/api/src/projects/routes/project-spaces.ts).
// A space is a channel of the project or the caller's DM with one agent. A
// session filed into a space carries its `space_id` (`createProjectSession`,
// `listProjectSessions({ spaceId })`). Every route answers 403
// `feature_disabled` while the project's `project_channels` flag is off.

import { backendApi } from '../../http/api-client';
import type { App } from './apps';
import { unwrap } from './shared';

/** A channel of the project, or the caller's DM with one agent. Same fields as the API's `Space`. */
export interface ProjectSpace {
  space_id: string;
  kind: 'channel' | 'dm';
  /** Channels: lowercase `a-z0-9-`, 1–40 characters. Null for a DM. */
  slug: string | null;
  name: string;
  description: string | null;
  /** True for the project's `#general` only. */
  is_default: boolean;
  /** The agent of a DM. Null for a channel. */
  dm_agent_name: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** The caller may rename, describe, archive and unarchive it: the channel's creator or a project manager. False for a DM. Absent on older APIs. */
  can_edit?: boolean;
}

export interface CreateProjectSpaceInput {
  /** 1–80 characters. The slug is derived from it. */
  name: string;
  /** At most 500 characters. */
  description?: string;
}

export interface UpdateProjectSpaceInput {
  name?: string;
  /** `null` clears the description. */
  description?: string | null;
  /** `true` archives the channel; `false` unarchives it. */
  archived?: boolean;
}

/**
 * The project's live channels (`#general` first, then oldest first), then the
 * caller's DMs. The first call creates `#general`. A background read: a
 * failure reaches the caller's query state, not the host error handler.
 */
export async function listProjectSpaces(projectId: string): Promise<ProjectSpace[]> {
  const body = unwrap(
    await backendApi.get<{ spaces: ProjectSpace[] }>(`/projects/${projectId}/spaces`, { showErrors: false }),
  );
  return body.spaces;
}

/**
 * `#general`'s "turned on again" line: `count` sessions started while Channels
 * was off were filed into `#general` at `at`. Present for 7 days after the switch.
 */
export interface ProjectSpaceGeneralNotice {
  kind: 'reenabled';
  at: string;
  count: number;
}

/**
 * `#general`'s "turned on again" line, or null when there is none. Read from
 * the spaces list (`GET /spaces`), so it costs the same request. A background read.
 */
export async function getProjectSpaceGeneralNotice(projectId: string): Promise<ProjectSpaceGeneralNotice | null> {
  const body = unwrap(
    await backendApi.get<{ general_notice?: ProjectSpaceGeneralNotice }>(`/projects/${projectId}/spaces`, {
      showErrors: false,
    }),
  );
  return body.general_notice ?? null;
}

/**
 * Create a channel. A name whose slug is taken rejects with an `ApiError`:
 * `status` 409, `code` `'slug_taken'`, and `data.space_id` / `data.archived`
 * name the existing channel; `data.can_edit` says whether the caller may
 * unarchive it, so the caller offers that only when it may. A name
 * with no slug characters rejects with 400 `invalid_name`. The caller shows
 * both, so neither reaches the host error handler.
 */
export async function createProjectSpace(projectId: string, input: CreateProjectSpaceInput) {
  return unwrap(
    await backendApi.post<ProjectSpace>(`/projects/${projectId}/spaces`, input, { showErrors: false }),
  );
}

/**
 * Rename, describe, archive or unarchive a channel. Only its creator or a
 * project manager may (`can_edit`); anyone else rejects with 403 `forbidden`.
 * A rename whose slug is taken rejects with 409 `slug_taken` (fields as in
 * `createProjectSpace`). The caller shows the error, so it never reaches the
 * host error handler.
 */
export async function updateProjectSpace(projectId: string, spaceId: string, input: UpdateProjectSpaceInput) {
  return unwrap(
    await backendApi.patch<ProjectSpace>(`/projects/${projectId}/spaces/${spaceId}`, input, { showErrors: false }),
  );
}

/**
 * The caller's DM with `agentName`, created on the first call. An agent the
 * project does not declare rejects with 404 `agent_not_found`. The caller
 * shows the error, so it never reaches the host error handler.
 */
export async function getOrCreateProjectDm(projectId: string, agentName: string) {
  return unwrap(
    await backendApi.post<ProjectSpace>(`/projects/${projectId}/spaces/dm`, { agent_name: agentName }, { showErrors: false }),
  );
}

/** A link of a channel (its Links tab): added with "Add link" or shared in a thread. Same fields as the API's `SpaceLink`. */
export interface ProjectSpaceLink {
  link_id: string;
  space_id: string;
  url: string;
  title: string | null;
  created_by: string | null;
  /** The creator's display name or email; null when unknown. */
  created_by_name: string | null;
  created_at: string;
  /** The caller may remove it: they added it, or they manage the project. */
  can_delete: boolean;
  /** Agents in the channel read pinned links. "Add link" pins; a link shared in a thread is unpinned until a member pins it. */
  pinned: boolean;
  /** Who pinned it; null while unpinned or when unknown. */
  pinned_by_name: string | null;
  /** When it was pinned; null while unpinned. */
  pinned_at: string | null;
  /** `manual`: added with "Add link". `message`: collected from a person's message in a thread of the channel. */
  source: 'manual' | 'message';
  /** The latest thread that shared it; null for a link no thread shared. */
  session_id: string | null;
  /** How many messages shared it. */
  share_count: number;
  last_shared_at: string;
  /** The row's name: the title a member gave, else the page's fetched title, else the decoded path, else the host. Absent on older APIs: fall back to `title ?? url`. */
  display_title?: string;
  /** The page's `og:site_name`, fetched by the server; null until fetched or when the page has none. Absent on older APIs. */
  site_name?: string | null;
  /** The page's icon URL, fetched by the server; null until fetched or when none passed the address check. A remote URL: load it only through an image proxy. Absent on older APIs. */
  icon_url?: string | null;
}

export interface AddProjectSpaceLinkInput {
  /** An http(s) URL, at most 2,048 characters. */
  url: string;
  /** At most 200 characters. */
  title?: string;
}

/** The counts beside a channel's tab labels. Fields are added over time, never renamed. */
export interface ProjectSpaceSummary {
  apps: number;
  links: number;
  /** Triggers that post to the space; 0 without the trigger read permission. */
  triggers: number;
}

/**
 * The channel's Apps: the project's Apps with a deployment made from one of
 * its threads, only those the caller may open. A background read.
 */
export async function listProjectSpaceApps(projectId: string, spaceId: string): Promise<App[]> {
  const body = unwrap(
    await backendApi.get<{ apps: App[] }>(`/projects/${projectId}/spaces/${spaceId}/apps`, { showErrors: false }),
  );
  return body.apps;
}

/** The channel's links, newest first. A background read. */
export async function listProjectSpaceLinks(projectId: string, spaceId: string): Promise<ProjectSpaceLink[]> {
  const body = unwrap(
    await backendApi.get<{ links: ProjectSpaceLink[] }>(`/projects/${projectId}/spaces/${spaceId}/links`, {
      showErrors: false,
    }),
  );
  return body.links;
}

/**
 * Pin a link to a channel. A URL that is not http(s), longer than 2,048
 * characters, or a title over 200 rejects with 400. A channel that already
 * holds 200 links rejects with 409 `link_limit`. The caller shows both. The
 * stored `url` is the parsed form (`new URL(url).href`).
 */
export async function addProjectSpaceLink(projectId: string, spaceId: string, input: AddProjectSpaceLinkInput) {
  return unwrap(
    await backendApi.post<ProjectSpaceLink>(`/projects/${projectId}/spaces/${spaceId}/links`, input, {
      showErrors: false,
    }),
  );
}

/** Remove a link. Only its creator or a project manager may: anyone else gets 403 `forbidden`. */
export async function removeProjectSpaceLink(projectId: string, spaceId: string, linkId: string): Promise<void> {
  unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/spaces/${spaceId}/links/${linkId}`, {
      showErrors: false,
    }),
  );
}

/**
 * Pin or unpin a link. Agents in the channel read the pinned ones. Returns the
 * link, or null when unpinning a link no thread shared removed it (only its
 * creator or a project manager may: anyone else gets 403 `forbidden`). A
 * channel that already pins 200 links rejects pinning with 409 `link_limit`.
 */
export async function pinProjectSpaceLink(
  projectId: string,
  spaceId: string,
  linkId: string,
  pinned: boolean,
): Promise<ProjectSpaceLink | null> {
  const body = unwrap(
    await backendApi.patch<{ link: ProjectSpaceLink | null }>(
      `/projects/${projectId}/spaces/${spaceId}/links/${linkId}`,
      { pinned },
      { showErrors: false },
    ),
  );
  return body.link;
}

/** The counts beside a channel's or the caller's DM's tab labels (a DM has no Apps or links: 0). A background read. */
export async function getProjectSpaceSummary(projectId: string, spaceId: string): Promise<ProjectSpaceSummary> {
  return unwrap(
    await backendApi.get<ProjectSpaceSummary>(`/projects/${projectId}/spaces/${spaceId}/summary`, { showErrors: false }),
  );
}

/** A mark a member leaves once per project: the intro dialog seen, or a "Get started" row done or dismissed. */
export type ChannelsOnboardingMark =
  | 'channels_intro'
  | 'get_started.dismissed'
  | 'get_started.channel'
  | 'get_started.remember'
  | 'get_started.dm';

/**
 * The caller's Channels onboarding state. A "Get started" row is done when its
 * mark is present or its fact is true: the caller created a channel, saved
 * memory in `#general`, or owns a DM.
 */
export interface ChannelsOnboarding {
  /** The member intro dialog was seen (or Channels was turned on again). */
  intro_seen: boolean;
  get_started: {
    /** Show the block: not dismissed and not every row done. */
    visible: boolean;
    create_channel: boolean;
    remember: boolean;
    open_dm: boolean;
  };
}

/** The caller's Channels onboarding state. A background read. */
export async function getChannelsOnboarding(projectId: string): Promise<ChannelsOnboarding> {
  return unwrap(
    await backendApi.get<ChannelsOnboarding>(`/projects/${projectId}/onboarding/channels`, { showErrors: false }),
  );
}

/** Record one onboarding mark for the caller. Idempotent. An unknown mark rejects with 400; the caller shows it. */
export async function markChannelsOnboarding(projectId: string, mark: ChannelsOnboardingMark): Promise<void> {
  unwrap(
    await backendApi.post<unknown>(`/projects/${projectId}/onboarding/channels/marks`, { mark }, { showErrors: false }),
  );
}
