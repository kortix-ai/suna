'use client';

import { CheckIcon as Check, LinkSimpleIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { usePublicShareLink } from '@/hooks/use-public-share-link';
import { cn } from '@/lib/utils';
import type { CreateSessionPublicShareInput } from '@kortix/sdk';

export function PublicShareLinkButton({
  workspaceId,
  sessionId,
  input,
  tooltip = 'Copy a public view-only link',
  title = 'Copy public link',
  className,
  iconClassName = 'size-4',
  tooltipSideOffset,
}: {
  workspaceId?: string;
  sessionId?: string;
  input: CreateSessionPublicShareInput | null;
  tooltip?: string;
  title?: string;
  className?: string;
  /** Icon size override. Defaults to this component's own 16px. */
  iconClassName?: string;
  /** Tooltip sideOffset override. Omit to keep `Hint`'s own default. */
  tooltipSideOffset?: number;
}) {
  const share = usePublicShareLink({ workspaceId, sessionId, input });
  const disabled = !share.canShare || share.isPending;

  return (
    <Hint
      label={share.copied ? 'Copied' : tooltip}
      side="bottom"
      sideOffset={tooltipSideOffset}
      className="max-w-56 text-xs"
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn('size-8 active:scale-[0.96]', className)}
        onClick={share.copyLink}
        disabled={disabled}
        title={title}
      >
        {share.isPending ? (
          <Loading className={cn(iconClassName, 'shrink-0')} />
        ) : (
          <span className={cn('relative inline-flex items-center justify-center', iconClassName)}>
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={share.copied ? 'check' : 'link'}
                initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="absolute inset-0 inline-flex items-center justify-center"
              >
                {share.copied ? (
                  <Check className={cn(iconClassName, 'text-kortix-green')} />
                ) : (
                  <LinkSimpleIcon className={iconClassName} />
                )}
              </m.span>
            </AnimatePresence>
          </span>
        )}
      </Button>
    </Hint>
  );
}
