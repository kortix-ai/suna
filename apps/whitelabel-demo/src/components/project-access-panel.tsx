'use client';

import { useWorkspace } from '@/components/workspace-access';
import { authClient } from '@/lib/auth-client';
import { UserCheckIcon } from '@phosphor-icons/react';

/**
 * Who this browser acts as, above the conversation: the Lumen user and the
 * workspace whose membership grants access. The Kortix credential stays on
 * the server.
 */
export function ApplicationUserBadge(_: { projectId: string }) {
  const { data } = authClient.useSession();
  const ws = useWorkspace();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-1.5 text-xs text-muted-foreground">
      <UserCheckIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {data?.user.email ?? '…'} in workspace {ws.name}. Access comes from your organization membership.
      </span>
    </div>
  );
}
