'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getRoom,
  listRoomMessages,
  listRooms,
  markRoomRead,
  postRoomMessage,
  type Room,
  type RoomConversation,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** How often an open conversation and the conversation list poll while the page is visible. */
const THREAD_POLL_MS = 3_000;
const LIST_POLL_MS = 15_000;

/** The project's named rooms (flag `agent_rooms`). */
export function useRooms(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.roomList(projectId ?? ''),
    queryFn: async () => (await listRooms(projectId as string)).rooms as Room[],
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

/** The rooms the caller is a member of, with unread counts. */
export function useRoomConversations(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.roomConversations(projectId ?? ''),
    queryFn: async () => (await listRooms(projectId as string, { mine: true })).rooms as RoomConversation[],
    enabled: !!projectId,
    ...contract('inventory'),
    refetchInterval: LIST_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** One conversation and its members. */
export function useRoom(projectId: string | null | undefined, roomId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.room(projectId ?? '', roomId ?? ''),
    queryFn: () => getRoom(projectId as string, roomId as string),
    enabled: !!projectId && !!roomId,
    ...contract('inventory'),
  });
}

/**
 * The newest messages of one conversation, polled while the page is visible,
 * with `post` and `markRead` (a person member's read cursor).
 */
export function useRoomMessages(
  projectId: string | null | undefined,
  roomId: string | null | undefined,
  options: { top?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.project.roomMessages(projectId ?? '', roomId ?? '', options.top ? 'top' : 'all'),
    queryFn: () => listRoomMessages(projectId as string, roomId as string, { limit: 200, top: options.top }),
    enabled: !!projectId && !!roomId,
    ...contract('inventory'),
    refetchInterval: THREAD_POLL_MS,
    refetchIntervalInBackground: false,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId ?? '') });
  const post = useMutation({
    mutationFn: (input: { text: string; reply_to?: number | null }) => postRoomMessage(projectId as string, roomId as string, input),
    onSuccess: invalidate,
  });
  const markRead = useMutation({
    mutationFn: (seq?: number) => markRoomRead(projectId as string, roomId as string, seq),
    onSuccess: invalidate,
  });
  return { ...query, post, markRead };
}

/**
 * One thread of a room (Slack-style): the root message and its replies, plus
 * `post` to reply in it. Off while `rootSeq` is null.
 */
export function useRoomThread(projectId: string | null | undefined, roomId: string | null | undefined, rootSeq: number | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.project.roomThread(projectId ?? '', roomId ?? '', rootSeq ?? 0),
    queryFn: () => listRoomMessages(projectId as string, roomId as string, { thread: rootSeq as number, limit: 200 }),
    enabled: !!projectId && !!roomId && rootSeq !== null,
    ...contract('inventory'),
    refetchInterval: THREAD_POLL_MS,
    refetchIntervalInBackground: false,
  });
  const post = useMutation({
    mutationFn: (text: string) => postRoomMessage(projectId as string, roomId as string, { text, reply_to: rootSeq }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId ?? '') }),
  });
  return { ...query, post };
}
