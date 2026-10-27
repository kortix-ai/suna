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
  /**
   * The channel's agents, in order: the first is the channel's default for a
   * new thread. Empty: no agent list, a new thread starts on the project's
   * default. Always empty for a DM. Absent on older APIs.
   */
  agents?: string[];
  /**
   * The caller is in the channel: always for `#general` and a DM, for another
   * channel once added or joined. A non-member of a public channel still
   * reads and posts. Absent on older APIs.
   */
  is_member?: boolean;
  /**
   * `public`: every project member sees and opens it. `private`: only its
   * members see the channel and its threads. `#general` and a DM are always
   * `public`. Absent on older APIs (read it as `public`).
   */
  visibility?: 'public' | 'private';
}

export interface CreateProjectSpaceInput {
  /** 1–80 characters. The slug is derived from it. */
  name: string;
  /** At most 500 characters. */
  description?: string;
  /** People added with the creator (who is always a member); every id a member of the project, at most 100. */
  member_ids?: string[];
  /** Default `public`. `private`: only its members see it. */
  visibility?: 'public' | 'private';
}

export interface UpdateProjectSpaceInput {
  name?: string;
  /** `null` clears the description. */
  description?: string | null;
  /** `true` archives the channel; `false` unarchives it. */
  archived?: boolean;
  /**
   * Replaces the channel's agent list, in order: the first is the default.
   * Every name must be an agent of the project, each once (else 400
   * `invalid_agents`); at most 50. `[]` clears it.
   */
  agents?: string[];
  /**
   * `private` makes a public channel private: the people who started a thread
   * in it or added a link become members. One way only.
   */
  visibility?: 'private';
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
 * Whether this deployment lets a channel be private (create with `visibility:
 * 'private'`, or make one private). Read from the spaces list; an older API
 * that sends no field reads false. A background read.
 */
export async function getPrivateChannelsAvailable(projectId: string): Promise<boolean> {
  const body = unwrap(
    await backendApi.get<{ private_channels_available?: boolean }>(`/projects/${projectId}/spaces`, {
      showErrors: false,
    }),
  );
  return body.private_channels_available === true;
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
 * Rename, describe, archive or unarchive a channel, or replace its agent list. Only its creator or a
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

/** A person in a channel. Same fields as the API's `SpaceMember`. */
export interface ProjectSpaceMember {
  user_id: string;
  /** The display name, else the email's local part. Never an email. */
  name: string;
  avatar_url: string | null;
  /** The channel's creator. */
  is_creator: boolean;
  is_viewer: boolean;
  /** When they were added or joined; null in `#general` and for backfilled rows. */
  added_at: string | null;
  /** The caller may remove them: a manager anyone, the creator anyone but themself, a member only themself (Leave). */
  can_remove: boolean;
}

/** A channel's people: the same list for every viewer, the caller first. */
export interface ProjectSpaceMemberList {
  members: ProjectSpaceMember[];
  /** `#general`: every project member is in it; nobody is added and nobody leaves. */
  implicit: boolean;
  /** The caller may add people: a member of the channel, its creator or a project manager. */
  can_add: boolean;
}

/** A channel's people. `#general` lists every project member. A background read. */
export async function listProjectSpaceMembers(projectId: string, spaceId: string): Promise<ProjectSpaceMemberList> {
  return unwrap(
    await backendApi.get<ProjectSpaceMemberList>(`/projects/${projectId}/spaces/${spaceId}/members`, { showErrors: false }),
  );
}

/**
 * Add people to a channel in one request; resolves to the list after the add.
 * Someone already in it is skipped. An id outside the project rejects with
 * 400 `not_project_member` (`data.user_ids` names them; nobody is added). A
 * caller outside the channel who is neither its creator nor a project manager
 * rejects with 403 `forbidden`. `#general` rejects with 400 `default_channel`.
 * The caller shows the error.
 */
export async function addProjectSpaceMembers(
  projectId: string,
  spaceId: string,
  userIds: string[],
): Promise<ProjectSpaceMemberList> {
  return unwrap(
    await backendApi.post<ProjectSpaceMemberList>(
      `/projects/${projectId}/spaces/${spaceId}/members`,
      { user_ids: userIds },
      { showErrors: false },
    ),
  );
}

/**
 * Remove someone from a channel; resolves to the list after. A manager
 * removes anyone, the creator anyone but themself, a member only themself.
 * The creator rejects with 403 `creator_not_removable` unless a manager
 * removes them; another refusal is 403 `forbidden`.
 */
export async function removeProjectSpaceMember(
  projectId: string,
  spaceId: string,
  userId: string,
): Promise<ProjectSpaceMemberList> {
  return unwrap(
    await backendApi.delete<ProjectSpaceMemberList>(`/projects/${projectId}/spaces/${spaceId}/members/${userId}`, {
      showErrors: false,
    }),
  );
}

/** A private channel the caller is not in, as a project manager sees it: no content (`GET /spaces/private`). */
export interface PrivateChannelSummary {
  space_id: string;
  name: string;
  slug: string;
  /** Its people who still have project access. 0: everyone left, a manager can add people. */
  member_count: number;
  created_by: string | null;
  /** The creator's display name, null when unknown. */
  created_by_name: string | null;
  created_at: string;
  archived_at: string | null;
}

/**
 * Project managers: the private channels they are not in, archived ones too.
 * A manager renames or archives one with `updateProjectSpace` and adds or
 * removes its people with `addProjectSpaceMembers` / `removeProjectSpaceMember`
 * (never themself: 403 `manager_self_add`). Anyone else rejects with 403
 * `forbidden`. A background read.
 */
export async function listPrivateChannelsNotIn(projectId: string): Promise<PrivateChannelSummary[]> {
  return unwrap(
    await backendApi.get<{ channels: PrivateChannelSummary[] }>(`/projects/${projectId}/spaces/private`, { showErrors: false }),
  ).channels;
}

/** The caller joins a public channel. Idempotent. `#general` rejects with 400 `default_channel`. */
export async function joinProjectSpace(projectId: string, spaceId: string): Promise<ProjectSpaceMemberList> {
  return unwrap(
    await backendApi.post<ProjectSpaceMemberList>(`/projects/${projectId}/spaces/${spaceId}/join`, undefined, {
      showErrors: false,
    }),
  );
}

/** The caller leaves a channel. Its creator rejects with 403 `creator_not_removable` (only a manager removes them). */
export async function leaveProjectSpace(projectId: string, spaceId: string): Promise<ProjectSpaceMemberList> {
  return removeProjectSpaceMember(projectId, spaceId, 'me');
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
  /** Agents in the channel read pinned links. Every link starts unpinned (added or shared in a thread) until a member pins it. */
  pinned: boolean;
  /** Who pinned it; null while unpinned or when unknown. */
  pinned_by_name: string | null;
  /** When it was pinned; null while unpinned. */
  pinned_at: string | null;
  /** `manual`: added with "Add link". `message`: collected from a person's message in a thread of the channel. */
  source: 'manual' | 'message';
  /** The latest thread that shared it; null for a link no thread shared. */
  session_id: string | null;
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
 * Add a link to a channel, unpinned, with the caller as its adder. A URL that
 * is not http(s), longer than 2,048 characters, or a title over 200 rejects
 * with 400. A channel that already holds 200 added links rejects with 409
 * `link_limit`. The caller shows both. The
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
 * Pin or unpin a link. Agents in the channel read the pinned ones. Unpinning
 * only clears the pin: the link stays listed (`removeProjectSpaceLink` removes
 * it). Returns the link; null only from an older server, where unpinning an
 * added link removed it. A channel that already pins 200 links rejects pinning
 * with 409 `link_limit`.
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
