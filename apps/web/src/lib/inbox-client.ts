import { backendApi } from '@/lib/api-client';

export type InboxItemKind = 'run_completed' | 'run_failed';

export interface InboxItem {
  id: string;
  project_id: string;
  session_id: string | null;
  kind: InboxItemKind;
  title: string;
  source: string | null;
  metadata: Record<string, unknown>;
  read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface InboxResponse {
  items: InboxItem[];
  unread_count: number;
}

export interface MarkReadResult {
  updated: number;
  unread_count: number;
}

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }): T {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Inbox request failed');
  }
  return response.data;
}

export async function getProjectInbox(
  projectId: string,
  opts?: { unreadOnly?: boolean },
): Promise<InboxResponse> {
  const suffix = opts?.unreadOnly ? '?filter=unread' : '';
  return unwrap(await backendApi.get<InboxResponse>(`/projects/${projectId}/inbox${suffix}`));
}

export async function markInboxRead(
  projectId: string,
  selection: { item_ids?: string[]; session_id?: string; all?: boolean },
): Promise<MarkReadResult> {
  return unwrap(
    await backendApi.post<MarkReadResult>(`/projects/${projectId}/inbox/read`, selection),
  );
}
