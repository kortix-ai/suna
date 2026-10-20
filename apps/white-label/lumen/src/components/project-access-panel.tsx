'use client';

import { useFirm, useMatter } from '@/components/access';
import { authClient } from '@/lib/auth-client';
import { UserCheckIcon } from '@phosphor-icons/react';

/**
 * Who this browser acts as, above the conversation: the Lumen user, the firm
 * and the matter whose access grants it. The platform credential stays on
 * the server.
 */
export function ApplicationUserBadge(_: { projectId: string }) {
  const { data } = authClient.useSession();
  const firm = useFirm();
  const { matter } = useMatter();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-1.5 text-xs text-muted-foreground">
      <UserCheckIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {data?.user.email ?? '…'} at {firm.name}, in {matter.name}. Access comes from your role on this matter.
      </span>
    </div>
  );
}
