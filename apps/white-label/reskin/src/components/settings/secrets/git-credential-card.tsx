'use client';

/** The "Git credential" card: the token field and its setGitCredential call. */

import Loading from '@kortix/ui/loading';

import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import { Input } from '@kortix/ui/input';
import { kortix } from '@/lib/kortix';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { errorToast, successToast } from '@kortix/ui/toast';
import { GitBranchIcon } from '@phosphor-icons/react';

export function GitCredentialCard({ projectId }: { projectId: string }) {
  const [gitToken, setGitToken] = useState('');

  const setGitCredential = useMutation({
    mutationFn: () =>
      kortix.project(projectId).secrets.setGitCredential({ token: gitToken.trim() }),
    onSuccess: () => {
      setGitToken('');
      successToast('Git credential saved');
    },
    onError: () => errorToast('Could not save git credential'),
  });

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <GitBranchIcon className="size-4 text-muted-foreground" /> Git credential
      </div>
      <p className="text-xs text-muted-foreground">
        A token the agent uses to clone and push to the project repository.
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (gitToken.trim()) setGitCredential.mutate();
        }}
      >
        <Input
          value={gitToken}
          onChange={(e) => setGitToken(e.target.value)}
          placeholder="ghp_…"
          type="password"
          className="min-w-[12rem] flex-1 font-mono"
        />
        <Button type="submit" disabled={!gitToken.trim() || setGitCredential.isPending}>
          {setGitCredential.isPending && <Loading className="size-4" />}
          Save credential
        </Button>
      </form>
    </Card>
  );
}
