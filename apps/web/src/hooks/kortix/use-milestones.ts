'use client';

/**
 * Milestone hooks — list/get/create/update/close/reopen/delete/events.
 *
 * Thin wrapper over `@kortix/sdk/react` (`use-kortix-master.ts`): the
 * react-query layer lives in the SDK now — none of these hooks ever read
 * `useAuth()`, so there is no identity to inject here. This file exists only
 * so existing importers of `apps/web/src/hooks/kortix/use-milestones` keep
 * working unchanged.
 */

import {
  milestoneKeys,
  useMilestones,
  useMilestone,
  useMilestoneEvents,
  useCreateMilestone,
  useUpdateMilestone,
  useCloseMilestone,
  useReopenMilestone,
  useDeleteMilestone,
  useSetTicketMilestone,
  type MilestoneStatus,
  type MilestoneProgress,
  type Milestone,
  type MilestoneDetail,
  type MilestoneEvent,
  type CreateMilestoneInput,
  type UpdateMilestoneInput,
} from '@kortix/sdk/react';

// The request/response shapes live in the SDK now (`@kortix/sdk/react`);
// re-exported here for existing importers.
export type { MilestoneStatus, MilestoneProgress, Milestone, MilestoneDetail, MilestoneEvent, CreateMilestoneInput, UpdateMilestoneInput };

export {
  milestoneKeys,
  useMilestones,
  useMilestone,
  useMilestoneEvents,
  useCreateMilestone,
  useUpdateMilestone,
  useCloseMilestone,
  useReopenMilestone,
  useDeleteMilestone,
  useSetTicketMilestone,
};
