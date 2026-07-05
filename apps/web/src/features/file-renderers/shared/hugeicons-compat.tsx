'use client';

import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  ChevronLeft,
  ChevronRight,
  CircleMinus,
  CirclePlus,
  Download,
  Ellipsis,
  FileDiff,
  MessageSquare,
  Moon,
  PanelLeft,
  RotateCw,
  Search,
  Upload,
} from 'lucide-react';

// Drop-in replacements for @hugeicons/core-free-icons names used by the
// vendored extend.ai viewers, so vendor diffs stay minimal on refresh.
export const ArrowLeft01Icon = ChevronLeft;
export const ArrowRight01Icon = ChevronRight;
export const Comment01Icon = MessageSquare;
export const Download01Icon = Download;
export const FileDiffIcon = FileDiff;
export const MinusSignCircleIcon = CircleMinus;
export const Moon02Icon = Moon;
export const MoreHorizontalIcon = Ellipsis;
export const PlusSignCircleIcon = CirclePlus;
export const RotateClockwiseIcon = RotateCw;
export const Search01Icon = Search;
export const SidebarLeftIcon = PanelLeft;
export const Upload01Icon = Upload;

type HugeiconsIconProps = Omit<LucideProps, 'ref'> & { icon: LucideIcon };

export function HugeiconsIcon({ icon: Icon, ...props }: HugeiconsIconProps) {
  return <Icon {...props} />;
}
