'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { upsertProjectSecret } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME } from './constants';

export function ClaudeSubscriptionConnect({
  projectId,
  onConnected,
}: {
  projectId: string;
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: () =>
      upsertProjectSecret(projectId, {
        name: CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
        value: token.trim(),
      }),
    onSuccess: async () => {
      successToast('Claude subscription connected');
      await queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      onConnected();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to connect Claude subscription'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim().length >= 20) save.mutate();
  };

  return (
    <form onSubmit={submit} className="bg-popover space-y-3 rounded-md border px-4 py-4">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID="anthropic" name="Anthropic" size="default" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Claude Pro, Max, Team, or Enterprise</p>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            Use your Claude subscription directly in the Claude Code harness.
          </p>
        </div>
      </div>
      <InfoBanner tone="info" icon={KeyRound} title="Generate a long-lived token locally">
        Run <code className="bg-muted rounded px-1 py-0.5 font-mono">claude setup-token</code> on
        your computer, finish the Anthropic login, then paste the generated token below. The token
        is encrypted and never shown again.
      </InfoBanner>
      <Input
        type="password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="Paste Claude setup token"
        autoComplete="off"
        aria-label="Claude subscription token"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || token.trim().length < 20}>
          {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Connect Claude
        </Button>
        <Button asChild type="button" variant="ghost" size="sm">
          <a
            href="https://docs.anthropic.com/en/docs/claude-code/iam"
            target="_blank"
            rel="noopener noreferrer"
          >
            Anthropic auth docs <ExternalLink className="size-3.5 shrink-0" />
          </a>
        </Button>
      </div>
    </form>
  );
}
