'use client';

import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { BookmarkSimpleIcon, type IconProps } from '@phosphor-icons/react';
import type { HTMLAttributes } from 'react';
import { Label } from '../ui/label';

export type CheckpointProps = HTMLAttributes<HTMLDivElement>;

export const Checkpoint = ({ className, children, ...props }: CheckpointProps) => (
  <div
    className={cn('text-muted-foreground flex items-center gap-0.5 overflow-hidden', className)}
    {...props}
  >
    {children}
    <Separator className="shrink grow basis-0 data-[orientation=horizontal]:w-auto" />
  </div>
);

export type CheckpointIconProps = IconProps;

export const CheckpointIcon = ({ className, children, ...props }: CheckpointIconProps) =>
  children ?? <BookmarkSimpleIcon className={cn('size-4 shrink-0', className)} {...props} />;

export type CheckpointLabelProps = HTMLAttributes<HTMLSpanElement>;

export const CheckpointLabel = ({ className, children, ...props }: CheckpointLabelProps) => (
  // Non-clickable status text: Label bakes cursor-pointer, keep the default.
  <Label className={cn('min-w-0 cursor-default truncate px-1 font-medium', className)} {...props}>
    {children}
  </Label>
);
