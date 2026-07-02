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
}: {
  projectId?: string;
  sessionId?: string;
  input: CreateSessionPublicShareInput | null;
  tooltip?: string;
  title?: string;
  className?: string;
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
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-56 text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
