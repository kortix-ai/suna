'use client';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { BookmarkSimpleIcon, type IconProps } from '@phosphor-icons/react';
import type { ComponentProps, HTMLAttributes } from 'react';
import Hint from '../ui/hint';
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
  <Label className={cn('min-w-0 cursor-default truncate px-1 font-medium', className)} {...props}>
    {children}
  </Label>
);

export type CheckpointTriggerProps = ComponentProps<typeof Button> & {
  tooltip?: string;
};

export const CheckpointTrigger = ({
  children,
  variant = 'ghost',
  size = 'sm',
  tooltip,
  ...props
}: CheckpointTriggerProps) =>
  tooltip ? (
    <Hint label={tooltip} align="start" side="bottom">
      <Button size={size} type="button" variant={variant} {...props}>
        {children}
      </Button>
    </Hint>
  ) : (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
    </Button>
  );
