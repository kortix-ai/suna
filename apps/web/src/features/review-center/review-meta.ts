/**
 * Presentation metadata for Review Center items — the single place that maps a
 * kind / risk / status / source to its icon, Kortix tone, and label. Mirrors the
 * tinted-icon-tile pattern from changes-view.tsx: a faint Kortix-token fill behind
 * a solid Kortix-token icon.
 */

import {
  ChatsIcon as ChatMessages,
  CheckCircleIcon as CheckCircleSolid,
  CommandIcon as Command,
  CreditCardIcon as CreditCardSolid,
  DatabaseIcon as Database,
  GitPullRequestIcon as GitPullRequest,
  MonitorIcon as Monitor,
  QuestionIcon as QuestionCircleSolid,
  PaperPlaneTiltIcon as Send,
  ShieldCheckIcon as ShieldCheckSolid,
  SparkleIcon as SparklesSolid,
  TerminalWindowIcon as Terminal,
} from '@phosphor-icons/react';
import { createElement, type ComponentType } from 'react';
import type {
  ApprovalActionIcon,
  ReviewKind,
  ReviewRisk,
  ReviewSource,
  ReviewStatus,
} from './types';

type IconCmp = ComponentType<{ className?: string }>;

/** Wraps a fill-intent icon so the tinted-icon-tile pattern (see file header)
 *  always renders it solid, without forcing `weight="fill"` on every icon
 *  this module re-exports (`GitPullRequest`, `Monitor`, `Send`, … stay
 *  outline). */
function filled(IconComponent: IconCmp): IconCmp {
  const Fillable = IconComponent as ComponentType<{ className?: string; weight?: 'fill' }>;
  return function FilledIcon({ className }: { className?: string }) {
    return createElement(Fillable, { className, weight: 'fill' });
  };
}
type BadgeVariant =
  'success' | 'warning' | 'destructive' | 'secondary' | 'muted' | 'kortix' | 'outline' | 'info';

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
    icon: filled(ShieldCheckSolid),
    tile: 'bg-kortix-orange/15',
    iconColor: 'text-kortix-orange',
  },
  output: {
    label: 'Output',
    icon: filled(SparklesSolid),
    tile: 'bg-kortix-purple/15',
    iconColor: 'text-kortix-purple',
  },
  decision: {
    label: 'Question',
    icon: filled(QuestionCircleSolid),
    tile: 'bg-kortix-yellow/15',
    // kortix-yellow is the palette's lowest-contrast glyph on a light tint. The
    // kind is always named in text beside the tile, so the glyph is redundant
    // and the token stays pure (no raw palette, no `dark:`).
    iconColor: 'text-kortix-yellow',
  },
  batch: {
    label: 'Finished',
    icon: filled(CheckCircleSolid),
    tile: 'bg-kortix-green/15',
    iconColor: 'text-kortix-green',
  },
};

// Every chip in the Review Center is the one `Badge` component — no second
// pill family (Jay, 2026-09-03: "use the badge component only").
export const RISK_META: Record<ReviewRisk, { label: string; badge: BadgeVariant }> = {
  none: { label: 'Safe', badge: 'success' },
  low: { label: 'Low risk', badge: 'success' },
  medium: { label: 'Medium risk', badge: 'warning' },
  high: { label: 'High risk', badge: 'destructive' },
};

/** A change's verification entries carry a tone; map it onto the Badge variant. */
export const VERIFICATION_BADGE: Record<'success' | 'warning' | 'neutral' | 'info', BadgeVariant> =
  {
    success: 'success',
    warning: 'warning',
    neutral: 'secondary',
    info: 'info',
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
  agent: { label: 'Agent', icon: filled(SparklesSolid) },
};

export const APPROVAL_ACTION_ICON: Record<ApprovalActionIcon, IconCmp> = {
  email: Send,
  charge: filled(CreditCardSolid),
  command: Terminal,
  data: Database,
  generic: Command,
};

export const SEGMENT_LABEL = {
  needs_you: 'Needs you',
  waiting: 'Waiting',
  done: 'Done',
} as const;
