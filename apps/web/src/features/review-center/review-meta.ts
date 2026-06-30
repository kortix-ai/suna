/**
 * Presentation metadata for Review Center items — the single place that maps a
 * kind / risk / status / source to its icon, Kortix tone, and label. Mirrors the
 * tinted-icon-tile pattern from changes-view.tsx: a faint Kortix-token fill behind
 * a solid Kortix-token icon.
 */

import type { StatusTone } from '@/components/ui/status';
import {
  ChatMessages,
  CheckCircleSolid,
  Command,
  CreditCardSolid,
  Database,
  GitPullRequest,
  Monitor,
  QuestionCircleSolid,
  Send,
  ShieldCheckSolid,
  SparklesSolid,
  Terminal,
} from '@mynaui/icons-react';
import type { ComponentType } from 'react';
import type {
  ApprovalActionIcon,
  ReviewKind,
  ReviewRisk,
  ReviewSource,
  ReviewStatus,
} from './types';

type IconCmp = ComponentType<{ className?: string }>;
type BadgeVariant =
  | 'success'
  | 'warning'
  | 'destructive'
  | 'secondary'
  | 'muted'
  | 'kortix'
  | 'outline';

export const KIND_META: Record<
  ReviewKind,
  { label: string; icon: IconCmp; tile: string; iconColor: string }
> = {
  change: {
    label: 'Change',
    icon: GitPullRequest,
    tile: 'bg-kortix-blue/15',
    iconColor: 'text-kortix-blue',
  },
  approval: {
    label: 'Approval',
    icon: ShieldCheckSolid,
    tile: 'bg-kortix-orange/15',
    iconColor: 'text-kortix-orange',
  },
  output: {
    label: 'Output',
    icon: SparklesSolid,
    tile: 'bg-kortix-purple/15',
    iconColor: 'text-kortix-purple',
  },
  decision: {
    label: 'Question',
    icon: QuestionCircleSolid,
    tile: 'bg-kortix-yellow/15',
    iconColor: 'text-kortix-yellow',
  },
  batch: {
    label: 'Finished',
    icon: CheckCircleSolid,
    tile: 'bg-kortix-green/15',
    iconColor: 'text-kortix-green',
  },
};

// Risk pills use StatusBadge (faint tinted fill + colored text) rather than the
// solid Badge variants — calmer and consistent across tones, the way the brand
// reads (red is the brake, not the paint). See components/ui/status.tsx.
export const RISK_META: Record<ReviewRisk, { label: string; tone: StatusTone }> = {
  none: { label: 'Safe', tone: 'success' },
  low: { label: 'Low risk', tone: 'success' },
  medium: { label: 'Medium risk', tone: 'warning' },
  high: { label: 'High risk', tone: 'destructive' },
};

export const STATUS_META: Record<ReviewStatus, { label: string; badge: BadgeVariant }> = {
  needs_you: { label: 'Needs you', badge: 'warning' },
  waiting: { label: 'Waiting on agent', badge: 'secondary' },
  approved: { label: 'Approved', badge: 'success' },
  changes_requested: { label: 'Changes requested', badge: 'warning' },
  rejected: { label: 'Rejected', badge: 'destructive' },
  done: { label: 'Done', badge: 'success' },
  dismissed: { label: 'Dismissed', badge: 'muted' },
};

export const SOURCE_META: Record<ReviewSource, { label: string; icon: IconCmp }> = {
  web: { label: 'Web', icon: Monitor },
  slack: { label: 'Slack', icon: ChatMessages },
  agent: { label: 'Agent', icon: SparklesSolid },
};

export const APPROVAL_ACTION_ICON: Record<ApprovalActionIcon, IconCmp> = {
  email: Send,
  charge: CreditCardSolid,
  command: Terminal,
  data: Database,
  generic: Command,
};

export const SEGMENT_LABEL = {
  needs_you: 'Needs you',
  waiting: 'Waiting',
  done: 'Done',
} as const;
