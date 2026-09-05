'use client';

/**
 * The subproject a session belongs to, as one chip.
 *
 * Rendered on the sidebar row and on the sessions page — the two places a
 * session shows up out of context. It renders nothing when the session
 * carries no subproject, and nothing on a surface already scoped to one
 * (the subproject page's own list), where every row would wear the same chip
 * and it would say nothing.
 */

import type { ProjectSession } from '@kortix/sdk';
import { FolderSimpleIcon } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function SubprojectBadge({
  session,
  className,
}: {
  session: Pick<ProjectSession, 'subproject'>;
  className?: string;
}) {
  const slug = session.subproject;
  if (!slug) return null;
  return (
    <Badge
      variant="outline"
      size="xs"
      className={cn('text-muted-foreground max-w-24 gap-1 font-medium', className)}
      title={slug}
    >
      <FolderSimpleIcon />
      <span className="min-w-0 truncate">{slug}</span>
    </Badge>
  );
}
