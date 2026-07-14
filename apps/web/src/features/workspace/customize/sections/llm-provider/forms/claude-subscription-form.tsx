'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { upsertProjectSecret } from '@kortix/sdk/projects-client';
import { invalidateComposerCapabilityQueries, type ModelsPageRuntime } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ExternalLink, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME } from '../constants';
import { applyUseWithSelections, defaultUseWithHarnesses, UseWithRuntimes } from './use-with-runtimes';

export function ClaudeSubscriptionForm({
  projectId,
  runtimes,
  onBack,
  onConnected,
}: {
  projectId: string;
  runtimes: ModelsPageRuntime[];
  onBack: () => void;
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [useWith, setUseWith] = useState(() => defaultUseWithHarnesses(['claude'], runtimes));

  const save = useMutation({
    mutationFn: async () => {
      await upsertProjectSecret(projectId, {
        name: CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
        value: token.trim(),
      });
      await applyUseWithSelections(projectId, 'claude_subscription', useWith);
    },
    onSuccess: async () => {
      successToast('Claude subscription connected');
      await invalidateComposerCapabilityQueries(queryClient, projectId);
      onConnected();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to connect Claude subscription'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim().length >= 20) save.mutate();
  };

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
        onClick={onBack}
      >
        <ChevronLeft className="size-3.5 shrink-0" />
        Back
      </Button>
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
        <div className="bg-muted/40 rounded-md border px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <KeyRound className="size-3.5 shrink-0" />
            Generate a long-lived token locally
          </div>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            Run <code className="bg-muted rounded px-1 py-0.5 font-mono">claude setup-token</code> on
            your computer, finish the Anthropic login, then paste the generated token below. The token
            is encrypted and never shown again.
          </p>
        </div>
        <Input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste Claude setup token"
          autoComplete="off"
          aria-label="Claude subscription token"
        />
        <UseWithRuntimes
          compatible={['claude']}
          runtimes={runtimes}
          value={useWith}
          onChange={setUseWith}
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
    </div>
  );
}
