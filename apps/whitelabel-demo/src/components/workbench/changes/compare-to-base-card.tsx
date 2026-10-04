'use client';

/**
 * The "Compare to base" card: owns its compare trigger and the versionDiff
 * query. It reads the default branch through the same query key the branches
 * list uses, so the shared cache answers without a second request — and
 * without the cast a prop threaded through here needed.
 */

import Loading from '@/components/ui/loading';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { useState } from 'react';
import { DiffStat } from './diff-view';

export function CompareToBaseCard({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const [comparing, setComparing] = useState(false);

  const branches = useQuery({
    queryKey: ['project-branches', projectId],
    queryFn: () => kortix.project(projectId).git.branches(),
  });
  const defaultBranch = branches.data?.default_branch;

  // "Compare to base": summarize the session branch against the default branch.
  const versionDiff = useQuery({
    queryKey: ['project-version-diff', projectId, defaultBranch, sessionId],
    enabled: comparing && !!defaultBranch,
    queryFn: () => {
      if (!defaultBranch) throw new Error('No base branch');
      return kortix.project(projectId).git.versionDiff({
        from: defaultBranch,
        into: sessionId,
      });
    },
  });

  const vd = versionDiff.data;

  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <Scale className="size-4 text-muted-foreground" />
            Compare to base
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setComparing(true)}
            disabled={!defaultBranch || versionDiff.isFetching}
          >
            {versionDiff.isFetching ? <Loading className="size-3" /> : null}
            Compare
          </Button>
        </CardTitle>
      </CardHeader>
      {comparing && (
        <CardContent className="text-xs text-muted-foreground">
          {versionDiff.isLoading ? (
            <Skeleton className="h-4 w-40" />
          ) : vd ? (
            vd.is_same_ref ? (
              <span>Session is on the base branch.</span>
            ) : vd.is_up_to_date ? (
              <span>Up to date with base.</span>
            ) : (
              <span className="flex items-center gap-2">
                <span className="font-mono text-foreground/80">
                  {vd.from} → {vd.into}
                </span>
                <span>{vd.files_changed} files</span>
                <DiffStat additions={vd.additions} deletions={vd.deletions} />
              </span>
            )
          ) : (
            <span>No diff available.</span>
          )}
        </CardContent>
      )}
    </Card>
  );
}
