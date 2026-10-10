'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteSessionReminder,
  deleteSessionReminders,
  listProjectReminders,
  listSessionReminders,
  updateSessionReminder,
  updateSessionReminders,
  type SessionReminderRef,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Every reminder in a project the caller can see, plus pause/resume
 * (`update`) and `remove`. A reminder changes when it fires, when its agent
 * sets one, and from other members, so this is the `inventory` tier.
 *
 * `updateMany` and `removeMany` act on a selection: a few requests at a
 * time, each reminder reported in the result, and the list refreshed once
 * when the batch settles, not once per reminder.
 */
export function useProjectReminders(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.project.reminders(projectId ?? ''),
    queryFn: () => listProjectReminders(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.project.reminders(projectId ?? '') });
  const update = useMutation({
    mutationFn: (args: { sessionId: string; reminderId: string; enabled: boolean }) =>
      updateSessionReminder(projectId as string, args.sessionId, args.reminderId, { enabled: args.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (args: { sessionId: string; reminderId: string }) =>
      deleteSessionReminder(projectId as string, args.sessionId, args.reminderId),
    onSuccess: invalidate,
  });
  const updateMany = useMutation({
    mutationFn: (args: { reminders: readonly SessionReminderRef[]; enabled: boolean }) =>
      updateSessionReminders(projectId as string, args.reminders, { enabled: args.enabled }),
    onSettled: invalidate,
  });
  const removeMany = useMutation({
    mutationFn: (args: { reminders: readonly SessionReminderRef[] }) =>
      deleteSessionReminders(projectId as string, args.reminders),
    onSettled: invalidate,
  });
  return { ...query, update, remove, updateMany, removeMany };
}

/** One session's reminders, with the same mutations bound to that session. */
export function useSessionReminders(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.project.sessionReminders(projectId ?? '', sessionId ?? ''),
    queryFn: () => listSessionReminders(projectId as string, sessionId as string),
    enabled: !!projectId && !!sessionId,
    ...contract('inventory'),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.project.reminders(projectId ?? '') });
  const update = useMutation({
    mutationFn: (args: { reminderId: string; enabled: boolean }) =>
      updateSessionReminder(projectId as string, sessionId as string, args.reminderId, { enabled: args.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (reminderId: string) => deleteSessionReminder(projectId as string, sessionId as string, reminderId),
    onSuccess: invalidate,
  });
  return { ...query, update, remove };
}
