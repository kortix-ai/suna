'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
/**
 * "Use your own Slack app" — the self-hosted / custom-scoped install path,
 * rebuilt as a guided three-step wizard in a Modal.
 *
 * **What this replaces.** `channels-view.tsx` used to render this flow as an
 * inline `Disclosure` holding a raw `<pre>` of manifest JSON, a two-state
 * `step` counter written out in prose ("Step 1 of 2 — …"), and two inputs
 * labelled with Slack's own API vocabulary ("Bot User OAuth Token (xoxb-…)",
 * "Signing Secret", stored in `project_secrets`). Every one of those is a
 * developer-facing artefact standing between a non-technical admin and a
 * working Slack bot.
 *
 * **The four changes that matter:**
 *
 * 1. **The JSON is a bounded peek, not a dump.** Step 1 shows the manifest in
 *    a ~3-line scrollable block with its own copy control
 *    (`manifest-copy-block.tsx`). The file is visibly real and auditable —
 *    scroll it and you read all of it — without forty lines of JSON landing on
 *    someone who only needs to paste it. This replaced a labelled "Copy setup
 *    file" button plus a separate disclosure holding the JSON: two affordances
 *    for one object, where the button asked for trust in an unseen file.
 * 2. **One action per step.** Step 1's old list item was four imperatives in a
 *    single sentence ("Click Open Slack, choose 'From a manifest', paste the
 *    JSON, confirm"). Creating the app, installing it, and pasting credentials
 *    are now three separate steps with three separate confirmations.
 * 3. **Real step structure.** The prose counter is now the shared `Stepper`
 *    (the same primitive `dev-view.tsx` uses), so progress is visible rather
 *    than described, and a user can jump back to a step they need to redo.
 * 4. **Copy names the screen, not the concept.** Each credential field says
 *    which Slack sidebar item it is on. `project_secrets` — an internal table
 *    name — is replaced by what a user actually needs to know: the values are
 *    encrypted and only this workspace's agent can read them.
 *
 * The mutation surface is unchanged: `useConnectSlack` with `bot_token` +
 * `signing_secret`, and `useSlackManifest` for the manifest text.
 */

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { successToast } from '@/components/ui/toast';
import { ManifestCopyBlock } from '@/features/workspace/customize/sections/component/manifest-copy-block';
import { useConnectSlack, useSlackManifest } from '@/hooks/channels/use-channels-installations';
import { cn } from '@/lib/utils';
import { CheckIcon, ArrowSquareOutIcon as ExternalLinkIcon, LockIcon } from '@phosphor-icons/react';
import { m } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';

const SLACK_NEW_APP_URL = 'https://api.slack.com/apps?new_app=1';

/** Ordered so `step` doubles as the `Stepper` value (1-indexed). */
const STEPS = [
  { step: 1, title: 'Create the app in Slack' },
  { step: 2, title: 'Install it to your workspace' },
  { step: 3, title: 'Paste two values back here' },
] as const;

type StepNumber = 1 | 2 | 3;

/** A numbered sub-instruction inside a step — one action, one line. */
function SubStep({ children }: { children: React.ReactNode }) {
  return <li className="text-muted-foreground text-sm leading-relaxed">{children}</li>;
}

/** Slack's own UI labels, so the eye can match text on screen to text here. */
function SlackUiLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-foreground font-medium">{children}</span>;
}

export function SlackByoWizard({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const steps = useLocalizedUiCatalog(STEPS);
  const [step, setStep] = useState<StepNumber>(1);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connect = useConnectSlack();
  const manifest = useSlackManifest(projectId);
  const manifestText = manifest.data ?? '';

  const credentialsFilled = botToken.trim().length > 0 && signingSecret.trim().length > 0;

  const submit = () => {
    setError(null);
    connect.mutate(
      { projectId, bot_token: botToken.trim(), signing_secret: signingSecret.trim() },
      {
        onSuccess: () => {
          successToast(tI18nComplete.raw('text1bfa15228ca8'));
          onOpenChange(false);
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not connect Slack'),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-xl">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('text260f0001800b')}</ModalTitle>
          <ModalDescription>{tI18nComplete.raw('text36e35c306f96')}</ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[65vh] overflow-y-auto">
          <Stepper
            orientation="vertical"
            count={steps.length}
            value={step}
            onValueChange={(v) => setStep(v as StepNumber)}
            className="flex w-full flex-col"
          >
            {steps.map(({ step: n, title }) => {
              const active = n === step;
              return (
                <div key={n} className="flex gap-3">
                  {/* `disabled` belongs on StepperItem, not the trigger — the
                      trigger reads it from item context. Only completed steps
                      are re-visitable; jumping ahead would skip the
                      confirmation each step exists to collect. */}
                  <StepperItem step={n} disabled={n > step} className="items-center">
                    <StepperTrigger className="flex shrink-0">
                      <StepperIndicator className="size-6 text-xs font-semibold tabular-nums">
                        {n < step ? <CheckIcon className="size-3" /> : n}
                      </StepperIndicator>
                    </StepperTrigger>
                    <StepperSeparator className="m-0" />
                  </StepperItem>

                  <div className={cn('min-w-0 flex-1 pt-0.5', active ? 'pb-6' : 'pb-4')}>
                    <StepperTitle
                      className={cn(
                        'transition-colors',
                        active ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {title}
                    </StepperTitle>

                    {active ? (
                      <m.div
                        key={`body-${n}`}
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                        className="mt-3 space-y-4"
                      >
                        {n === 1 ? (
                          <StepCreateApp
                            manifestText={manifestText}
                            loading={manifest.isLoading}
                            error={manifest.error instanceof Error ? manifest.error.message : null}
                            onNext={() => setStep(2)}
                          />
                        ) : null}
                        {n === 2 ? (
                          <StepInstall onBack={() => setStep(1)} onNext={() => setStep(3)} />
                        ) : null}
                        {n === 3 ? (
                          <StepCredentials
                            botToken={botToken}
                            signingSecret={signingSecret}
                            onBotTokenChange={setBotToken}
                            onSigningSecretChange={setSigningSecret}
                            error={error}
                          />
                        ) : null}
                      </m.div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </Stepper>
        </ModalBody>

        {/* Only the last step's action is a real commit, so only it gets the
            modal footer. Steps 1–2 advance from inside their own body, where
            the button sits next to the instruction it confirms. */}
        {step === 3 ? (
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => setStep(2)}>
              {tI18nComplete.raw('text76900f1bfd16')}
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={connect.isPending || !credentialsFilled}
            >
              {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('textaa665ddf2727')}
            </Button>
          </ModalFooter>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function StepCreateApp({
  manifestText,
  loading,
  error,
  onNext,
}: {
  manifestText: string;
  loading: boolean;
  error: string | null;
  onNext: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {tI18nComplete.raw('text9cdca2543fde')}
      </p>

      {/* The block IS both the copy control and the file preview. It replaced
          a "Copy setup file" button plus a separate "Show what's in the setup
          file" disclosure — two affordances for one object, where the button
          asked for trust in a file you could not see. */}
      <ManifestCopyBlock
        text={manifestText}
        filename="slack-app-manifest.json"
        loading={loading}
        error={error}
      />

      <div className="flex flex-col items-start gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" asChild>
          <Link href={SLACK_NEW_APP_URL} target="_blank" rel="noopener noreferrer">
            {tI18nComplete.raw('text4ddf02a36df5')}
            <ExternalLinkIcon className="size-3.5 shrink-0" />
          </Link>
        </Button>
      </div>

      <ol className="list-decimal space-y-1.5 pl-5">
        <SubStep>
          {tI18nComplete.raw('textc7f937836f5d')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('text41a4294b3596')}</SlackUiLabel>.
        </SubStep>
        <SubStep>{tI18nComplete.raw('text31e88533abff')}</SubStep>
        <SubStep>{tI18nComplete.raw('text35a932c5a252')}</SubStep>
      </ol>

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={onNext}>
          {tI18nComplete.raw('textbf16dc964c99')}
        </Button>
      </div>
    </>
  );
}

function StepInstall({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {tI18nComplete.raw('textf88927a8173f')}
      </p>

      <ol className="list-decimal space-y-1.5 pl-5">
        <SubStep>
          {tI18nComplete.raw('textf2da697d0ec4')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('text7f717f55d7c2')}</SlackUiLabel>{' '}
          {tI18nComplete.raw('text3ccc48a02ff4')}
        </SubStep>
        <SubStep>
          {tI18nComplete.raw('text95ba4ed9329f')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('text52141cfb5b12')}</SlackUiLabel>.
        </SubStep>
        <SubStep>
          {tI18nComplete.raw('text3022f99399d7')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('texte213c161d5ce')}</SlackUiLabel>.
        </SubStep>
      </ol>

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          {tI18nComplete.raw('text76900f1bfd16')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onNext}>
          {tI18nComplete.raw('texta695ac413d60')}
        </Button>
      </div>
    </>
  );
}

function StepCredentials({
  botToken,
  signingSecret,
  onBotTokenChange,
  onSigningSecretChange,
  error,
}: {
  botToken: string;
  signingSecret: string;
  onBotTokenChange: (v: string) => void;
  onSigningSecretChange: (v: string) => void;
  error: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="slack-bot-token">{tI18nComplete.raw('text5bb9aecca021')}</Label>
        <Input
          id="slack-bot-token"
          placeholder={tI18nComplete.raw('text154c1feb869c')}
          value={botToken}
          onChange={(e) => onBotTokenChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {tI18nComplete.raw('text74783b066cae')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('textd4caa96c198f')}</SlackUiLabel> →{' '}
          <SlackUiLabel>{tI18nComplete.raw('textd6b64bf5e951')}</SlackUiLabel>
          {tI18nComplete.raw('text640cb1c5ea06')} <code className="font-mono text-xs">xoxb-</code>.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="slack-signing-secret">{tI18nComplete.raw('texte7ee22e117a1')}</Label>
        <Input
          id="slack-signing-secret"
          placeholder="••••••••"
          type="password"
          value={signingSecret}
          onChange={(e) => onSigningSecretChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {tI18nComplete.raw('text74783b066cae')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('textd094b334d809')}</SlackUiLabel> →{' '}
          <SlackUiLabel>{tI18nComplete.raw('texta489d605af5a')}</SlackUiLabel> →{' '}
          <SlackUiLabel>{tI18nComplete.raw('textf5e81453d0e9')}</SlackUiLabel>
          {tI18nComplete.raw('text438812ba8432')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('text0df6f1cad36c')}</SlackUiLabel>{' '}
          {tI18nComplete.raw('text9a91c10f08c8')}
        </p>
      </div>

      <div className="text-muted-foreground flex items-start gap-2 text-xs leading-relaxed">
        <LockIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>{tI18nComplete.raw('texte4fbfdfe7290')}</span>
      </div>

      {error ? (
        <InfoBanner tone="destructive" title={tI18nComplete.raw('text8630b4dd33f2')}>
          {error}
        </InfoBanner>
      ) : null}
    </>
  );
}
