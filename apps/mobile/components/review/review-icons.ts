/**
 * review-icons — the icon of each review item kind. Kept apart from
 * `lib/review/review-meta.ts`, which is pure data under `bun test`.
 */
import type { ReviewItemKind } from '@kortix/sdk';

import {
  FileTextIcon,
  GitPullRequestIcon,
  QuestionIcon,
  ShieldCheckIcon,
  StackIcon,
  type AppIcon,
} from '@/lib/icons';

export const REVIEW_KIND_ICONS: Record<ReviewItemKind, AppIcon> = {
  change: GitPullRequestIcon,
  approval: ShieldCheckIcon,
  output: FileTextIcon,
  decision: QuestionIcon,
  batch: StackIcon,
};
