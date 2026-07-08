import type { ProjectSession, SessionFolder } from '@kortix/sdk/projects-client';

import { type SessionSourceKind, sessionSource } from './session-label';

/**
 * Sidebar folder grouping — the single place that decides which folder a
 * session renders under.
 *
 * Manual folders (server rows) win: a session with a `folder_id` the viewer
 * can see always renders inside that folder, whatever its source. Unfiled
 * automation sessions group under virtual AUTO folders (Slack / Email /
 * Scheduled / Webhooks…) derived from `sessionSource()`; unfiled chats stay
 * loose at the root. A `folder_id` pointing at a folder the viewer can't see
 * (someone else's private folder) degrades gracefully to unfiled.
 */

export type AutoFolderKind = Exclude<SessionSourceKind, 'chat'>;

/** Fixed render order for the virtual source folders. */
export const AUTO_FOLDER_ORDER: AutoFolderKind[] = [
  'slack',
  'telegram',
  'email',
  'schedule',
  'webhook',
];

export const AUTO_FOLDER_LABELS: Record<AutoFolderKind, string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  email: 'Email',
  schedule: 'Scheduled',
  webhook: 'Webhooks',
};

export function isAutoFolderKind(value: string): value is AutoFolderKind {
  return (AUTO_FOLDER_ORDER as string[]).includes(value);
}

/** Human label for a folder's share audience, from its unified visibility. */
export function folderShareLabel(visibility: SessionFolder['visibility']): string {
  if (visibility === 'project') return 'Shared with team';
  if (visibility === 'restricted') return 'Shared with members';
  return 'Private';
}

export interface FolderGroup {
  folder: SessionFolder;
  sessions: ProjectSession[];
}

export interface AutoFolderGroup {
  kind: AutoFolderKind;
  label: string;
  sessions: ProjectSession[];
}

export interface GroupedSessions {
  /** Manual folders in position order — includes empty ones (drop targets). */
  folders: FolderGroup[];
  /** Non-empty virtual source folders, in AUTO_FOLDER_ORDER. */
  auto: AutoFolderGroup[];
  /** Unfiled chat sessions, in the input order. */
  loose: ProjectSession[];
}

export function groupSessions(
  sessions: ProjectSession[],
  folders: SessionFolder[],
): GroupedSessions {
  const byFolder = new Map<string, ProjectSession[]>(folders.map((f) => [f.folder_id, []]));
  const byAuto = new Map<AutoFolderKind, ProjectSession[]>();
  const loose: ProjectSession[] = [];

  for (const session of sessions) {
    const manual = session.folder_id ? byFolder.get(session.folder_id) : undefined;
    if (manual) {
      manual.push(session);
      continue;
    }
    const kind = sessionSource(session).kind;
    if (kind === 'chat') {
      loose.push(session);
      continue;
    }
    const bucket = byAuto.get(kind) ?? [];
    bucket.push(session);
    byAuto.set(kind, bucket);
  }

  const ordered = folders
    .slice()
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  return {
    folders: ordered.map((folder) => ({ folder, sessions: byFolder.get(folder.folder_id) ?? [] })),
    auto: AUTO_FOLDER_ORDER.filter((kind) => byAuto.has(kind)).map((kind) => ({
      kind,
      label: AUTO_FOLDER_LABELS[kind],
      sessions: byAuto.get(kind)!,
    })),
    loose,
  };
}
