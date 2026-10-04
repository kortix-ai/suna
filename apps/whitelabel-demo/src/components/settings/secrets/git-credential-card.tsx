'use client';

/** The "Git credential" card: the token field and its setGitCredential call. */

import Loading from '@/components/ui/loading';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { kortix } from '@/lib/kortix';
import { useMutation } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function GitCredentialCard({ projectId }: { projectId: string }) {
  const [gitToken, setGitToken] = useState('');

  const setGitCredential = useMutation({
    mutationFn: () =>
      kortix.project(projectId).secrets.setGitCredential({ token: gitToken.trim() }),
    onSuccess: () => {
      setGitToken('');
      toast.success('Git credential saved');
    },
    onError: () => toast.error('Could not save git credential'),
  });

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <GitBranch className="size-4 text-muted-foreground" /> Git credential
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
