'use client';

import { useMutation } from '@tanstack/react-query';
import { Link2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  createSessionPublicShare,
  type CreateSessionPublicShareInput,
} from '@kortix/sdk/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function PublicShareLinkButton({
  projectId,
  sessionId,
  input,
  tooltip = 'Copy a public view-only link',
  title = 'Copy public link',
  className,
  iconClassName = 'h-4 w-4',
  tooltipSideOffset,
}: {
  projectId?: string;
  sessionId?: string;
  input: CreateSessionPublicShareInput | null;
  tooltip?: string;
  title?: string;
  className?: string;
  /** Icon size override. Defaults to this component's own 16px. */
  iconClassName?: string;
  /** TooltipContent sideOffset override. Omit to keep Radix's own default. */
  tooltipSideOffset?: number;
}) {
  const share = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionId || !input) {
        throw new Error('Nothing is selected to share');
      }
      const result = await createSessionPublicShare(projectId, sessionId, input);
      if (!result.share.public_path) {
        throw new Error('Share link was not returned');
      }
      const publicUrl = `${window.location.origin}${result.share.public_path}`;
      await navigator.clipboard.writeText(publicUrl);
      return publicUrl;
    },
    onSuccess: () => {
      toast.success('Public link copied');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not create public link');
    },
  });

  const disabled = !projectId || !sessionId || !input || share.isPending;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-8 w-8', className)}
          onClick={() => share.mutate()}
          disabled={disabled}
          title={title}
        >
          {share.isPending ? (
            <Loader2 className={cn(iconClassName, 'animate-spin')} />
          ) : (
            <Link2 className={cn(iconClassName)} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-56 text-xs" sideOffset={tooltipSideOffset}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
