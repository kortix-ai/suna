'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { upsertProjectSecret } from '@kortix/sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME } from './constants';

const SETUP_TOKEN_COMMAND = 'claude setup-token';

export function ClaudeSubscriptionConnect({
  projectId,
  onConnected,
}: {
  projectId: string;
  onConnected: (providerId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const trimmedToken = token.trim();

  const connect = useMutation({
    mutationFn: () =>
      upsertProjectSecret(projectId, {
        name: CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
        value: trimmedToken,
      }),
    onSuccess: () => {
      successToast('Claude subscription connected');
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      onConnected('claude');
    },
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to connect Claude subscription');
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmedToken.length < 20) return;
    connect.mutate();
  }

  return (
    <form onSubmit={submit} className="bg-popover space-y-4 rounded-md border px-4 py-5">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID="claude" name="Claude Code" size="default" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">Claude Code subscription</p>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            Use a Claude Pro, Max, Team, or Enterprise subscription in the Claude Code harness.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs text-pretty">
          Run this command on your computer. Sign in to Anthropic. Paste the token below.
        </p>
        <div className="bg-muted/40 relative rounded-md border px-3 py-2.5 pr-11">
          <code className="text-foreground block font-mono text-sm">{SETUP_TOKEN_COMMAND}</code>
          <div className="absolute top-1.5 right-1.5">
            <CopyButton code={SETUP_TOKEN_COMMAND} />
          </div>
        </div>
      </div>

      <Field>
        <FieldLabel htmlFor="claude-subscription-token">Setup token</FieldLabel>
        <Input
          id="claude-subscription-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste Claude setup token"
          autoComplete="off"
        />
        <FieldDescription>
          The encrypted project-wide value is stored as{' '}
          <code className="text-foreground/80 font-mono">
            {CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME}
          </code>
          .
        </FieldDescription>
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={connect.isPending || trimmedToken.length < 20}>
          {connect.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          Connect Claude
        </Button>
        <Button variant="transparent" size="sm" asChild>
          <a
            href="https://docs.anthropic.com/en/docs/claude-code/iam"
            target="_blank"
            rel="noopener noreferrer"
          >
            Anthropic auth docs
            <ExternalLink className="size-3.5 shrink-0" />
          </a>
        </Button>
      </div>

      <InfoBanner tone="neutral" icon={ShieldCheck}>
        The token is encrypted and never shown again.
      </InfoBanner>
    </form>
  );
}
