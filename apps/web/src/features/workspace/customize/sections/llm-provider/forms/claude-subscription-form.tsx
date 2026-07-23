'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { upsertProjectSecret } from '@kortix/sdk/projects-client';
import { invalidateComposerCapabilityQueries, type ModelsPageRuntime } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';

import { CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME } from '../constants';
import {
  applyUseWithSelections,
  defaultUseWithHarnesses,
  UseWithRuntimes,
} from './use-with-runtimes';

const SETUP_TOKEN_COMMAND = 'claude setup-token';

/** Live "looks like a token" hint under the paste field — same ≥20-char
 *  threshold the submit button gates on, phrased for someone who has never
 *  seen an OAuth token before. */
function tokenHint(trimmed: string): ReactNode {
  if (trimmed.length === 0)
    return (
      <>
        Paste the token from{' '}
        <code className="text-foreground/80 font-mono">{SETUP_TOKEN_COMMAND}</code>.
      </>
    );
  if (trimmed.length < 20) return 'Keep pasting — Claude tokens run long.';
  return 'Looks like a token.';
}

export function ClaudeSubscriptionForm({
  projectId,
  runtimes,
  onConnected,
}: {
  projectId: string;
  runtimes: ModelsPageRuntime[];
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [token, setToken] = useState('');
  const [useWith, setUseWith] = useState(() => defaultUseWithHarnesses(['claude'], runtimes));
  const trimmedToken = token.trim();

  const save = useMutation({
    mutationFn: async () => {
      await upsertProjectSecret(projectId, {
        name: CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
        value: trimmedToken,
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
    if (trimmedToken.length >= 20) save.mutate();
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

      <Stepper
        value={step}
        onValueChange={(next) => setStep(next >= 2 ? 2 : 1)}
        orientation="vertical"
        count={2}
        className="flex w-full flex-col"
      >
        <div className="flex gap-3.5">
          <StepperItem step={1} completed={step > 1} className="items-center">
            <StepperTrigger aria-label="Step 1: get a token">
              <StepperIndicator className="size-7 text-sm font-semibold tabular-nums">
                1
              </StepperIndicator>
            </StepperTrigger>
            <StepperSeparator className="bg-secondary m-0" />
          </StepperItem>
          <div className="min-w-0 flex-1 space-y-3 pb-5">
            <div className="space-y-0.5">
              <StepperTitle className="font-semibold">Get a token</StepperTitle>
              {step === 1 && (
                <StepperDescription className="leading-relaxed">
                  Run this on your computer, sign in with Anthropic, then come back and paste the
                  token it prints.
                </StepperDescription>
              )}
            </div>
            {step === 1 && (
              <>
                <div className="bg-muted/40 relative rounded-md border px-3 py-2.5 pr-11">
                  <code className="text-foreground block font-mono text-sm">
                    {SETUP_TOKEN_COMMAND}
                  </code>
                  <div className="absolute top-1.5 right-1.5">
                    <CopyButton code={SETUP_TOKEN_COMMAND} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" onClick={() => setStep(2)}>
                    Continue
                  </Button>
                  <Button variant="transparent" size="sm" asChild>
                    <a
                      href="https://docs.anthropic.com/en/docs/claude-code/iam"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Anthropic auth docs <ExternalLink className="size-3.5 shrink-0" />
                    </a>
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex gap-3.5">
          <StepperItem step={2} disabled={step < 2} className="items-center">
            <StepperTrigger aria-label="Step 2: paste it">
              <StepperIndicator className="size-7 text-sm font-semibold tabular-nums">
                2
              </StepperIndicator>
            </StepperTrigger>
          </StepperItem>
          <div className="min-w-0 flex-1 space-y-3">
            <StepperTitle className="font-semibold">Paste it</StepperTitle>
            {step === 2 && (
              <>
                <div className="space-y-1.5">
                  <Input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Paste Claude setup token"
                    autoComplete="off"
                    aria-label="Claude subscription token"
                    autoFocus
                  />
                  <div className="space-y-1">
                    <FieldDescription>{tokenHint(trimmedToken)}</FieldDescription>
                    <p className="text-muted-foreground text-xs">
                      The token is encrypted and never shown again.
                    </p>
                  </div>
                </div>
                <UseWithRuntimes
                  compatible={['claude']}
                  runtimes={runtimes}
                  value={useWith}
                  onChange={setUseWith}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={save.isPending || trimmedToken.length < 20}
                >
                  {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
                  Connect Claude
                </Button>
              </>
            )}
          </div>
        </div>
      </Stepper>
    </form>
  );
}
