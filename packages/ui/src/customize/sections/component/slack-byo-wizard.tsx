'use client';

import { useTranslations } from '../../../i18n';
import { useLocalizedUiCatalog } from '../../../i18n/ui-catalog/use-localized-ui-catalog';
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
 * 3. **Real step structure.** A two-pane modal: a rail on the left holds the
 *    `Stepper` (progress visible, completed steps re-visitable), the pane on
 *    the right holds one step and a footer with that step's one action.
 * 4. **Copy names the screen, not the concept.** Each credential field says
 *    which Slack sidebar item it is on. `project_secrets` — an internal table
 *    name — is replaced by what a user actually needs to know: the values are
 *    encrypted and only this workspace's agent can read them.
 *
 * The mutation surface is unchanged: `useConnectSlack` with `bot_token` +
 * `signing_secret`, and `useSlackManifest` for the manifest text.
 */

import { Button } from '../../../primitives/button';
import { InfoBanner } from '../../../primitives/info-banner';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import Loading from '../../../primitives/loading';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '../../../primitives/modal';
import { Alert, AlertDescription, AlertMedia } from '../../../primitives/alert';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '../../../primitives/stepper';
import { successToast } from '../../../primitives/toast';
import { Slack } from '../../../internal/icons/slack';
import { ManifestCopyBlock } from './manifest-copy-block';
import { useConnectSlack, useSlackManifest } from '../../../internal/hooks/channels/use-channels-installations';
import { cn } from '../../../internal/lib/utils';
import { ArrowSquareOutIcon as ExternalLinkIcon, CheckIcon, LockIcon } from '@phosphor-icons/react';
import { m } from 'motion/react';
import { UiLink as Link } from '../../../providers/ui-provider';
import { useState } from 'react';

const SLACK_NEW_APP_URL = 'https://api.slack.com/apps?new_app=1';

/** Ordered so `step` doubles as the `Stepper` value (1-indexed). */
const STEPS = [
  { step: 1, title: 'Create the app in Slack' },
  { step: 2, title: 'Install it to your workspace' },
  { step: 3, title: 'Paste two values back here' },
] as const;

type StepNumber = 1 | 2 | 3;

/** One action per line, lettered so it never competes with the step numbers. */
function SubSteps({ children }: { children: React.ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {children.map((child, i) => (
        <li key={i} className="flex gap-3 text-sm/relaxed">
          <span className="w-3 shrink-0 text-muted-foreground" aria-hidden>
            {String.fromCharCode(97 + i)}
          </span>
          <span className="text-pretty text-muted-foreground">{child}</span>
        </li>
      ))}
    </ol>
  );
}

/** Slack's own UI labels, so the eye can match text on screen to text here. */
function SlackUiLabel({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
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

  const leads: Record<StepNumber, string | null> = {
    1: tI18nComplete.raw('text9cdca2543fde'),
    2: tI18nComplete.raw('textf88927a8173f'),
    3: null,
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant="base"
        className="space-y-0 overflow-hidden lg:max-w-4xl lg:flex-row"
      >
        <aside className="flex flex-col gap-6 border-b bg-sidebar p-5 lg:w-72 lg:shrink-0 lg:border-e lg:border-b-0">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Slack className="size-5 shrink-0" />
              <ModalTitle className="text-base font-medium text-balance">
                {tI18nComplete.raw('text260f0001800b')}
              </ModalTitle>
            </div>
            <ModalDescription className="text-sm/relaxed text-pretty lg:sr-only">
              {tI18nComplete.raw('text36e35c306f96')}
            </ModalDescription>
          </div>

          <Stepper
            orientation="vertical"
            count={steps.length}
            value={step}
            onValueChange={(v) => {
              if (v === 1 || v === 2 || v === 3) setStep(v);
            }}
            className="flex flex-col"
          >
            {steps.map(({ step: n, title }) => (
              <div key={n} className="flex gap-3">
                {/* Only completed steps are re-visitable; jumping ahead would
                    skip the confirmation each step exists to collect. */}
                <StepperItem step={n} disabled={n > step} className="items-center">
                  <StepperTrigger>
                    <StepperIndicator className="tabular-nums">
                      {n < step ? <CheckIcon className="size-3" weight="bold" /> : n}
                    </StepperIndicator>
                  </StepperTrigger>
                  <StepperSeparator className="m-0" />
                </StepperItem>
                <StepperTitle
                  className={cn(
                    'pt-0.5 pb-6 transition-colors',
                    n === step ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {title}
                </StepperTitle>
              </div>
            ))}
          </Stepper>
        </aside>

        {/* min-h holds step 1's height, so the modal never shrinks between steps. */}
        <section className="flex min-w-0 flex-1 flex-col lg:min-h-176">
          <m.div
            key={step}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="flex-1 space-y-5 overflow-y-auto p-6 lg:max-h-[70vh]"
          >
            <header className="space-y-1 pe-8">
              <h2 className="text-lg font-medium text-balance text-foreground">
                {steps[step - 1].title}
              </h2>
              {leads[step] ? (
                <p className="text-sm/relaxed text-pretty text-muted-foreground">
                  {leads[step]}
                </p>
              ) : null}
            </header>

            {step === 1 ? (
              <StepCreateApp
                manifestText={manifest.data ?? ''}
                loading={manifest.isLoading}
                error={manifest.error instanceof Error ? manifest.error.message : null}
              />
            ) : null}
            {step === 2 ? <StepInstall /> : null}
            {step === 3 ? (
              <StepCredentials
                botToken={botToken}
                signingSecret={signingSecret}
                onBotTokenChange={setBotToken}
                onSigningSecretChange={setSigningSecret}
                error={error}
              />
            ) : null}
          </m.div>

          {/* [secondary] … [the step's one action]. */}
          <footer className="flex items-center justify-between gap-3 border-t px-6 py-4">
            {step === 1 ? (
              <Button size="sm" variant="outline" className="gap-1.5" asChild>
                <Link href={SLACK_NEW_APP_URL} target="_blank" rel="noopener noreferrer">
                  {tI18nComplete.raw('text4ddf02a36df5')}
                  <ExternalLinkIcon className="size-3.5 shrink-0" />
                </Link>
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setStep(step === 3 ? 2 : 1)}
              >
                {tI18nComplete.raw('text76900f1bfd16')}
              </Button>
            )}

            {step === 1 ? (
              <Button type="button" size="sm" onClick={() => setStep(2)}>
                {tI18nComplete.raw('textbf16dc964c99')}
              </Button>
            ) : null}
            {step === 2 ? (
              <Button type="button" size="sm" onClick={() => setStep(3)}>
                {tI18nComplete.raw('texta695ac413d60')}
              </Button>
            ) : null}
            {step === 3 ? (
              <Button
                type="button"
                size="sm"
                onClick={submit}
                disabled={connect.isPending || !credentialsFilled}
              >
                {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
                {tI18nComplete.raw('textaa665ddf2727')}
              </Button>
            ) : null}
          </footer>
        </section>
      </ModalContent>
    </Modal>
  );
}

function StepCreateApp({
  manifestText,
  loading,
  error,
}: {
  manifestText: string;
  loading: boolean;
  error: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      {/* The block IS both the copy control and the file preview: one
          affordance for one object, so nobody copies a file they cannot see. */}
      <ManifestCopyBlock
        text={manifestText}
        filename="slack-app-manifest.json"
        loading={loading}
        error={error}
      />

      <SubSteps>
        {[
          <>
            {tI18nComplete.raw('textc7f937836f5d')}{' '}
            <SlackUiLabel>{tI18nComplete.raw('text41a4294b3596')}</SlackUiLabel>.
          </>,
          tI18nComplete.raw('text31e88533abff'),
          tI18nComplete.raw('text35a932c5a252'),
        ]}
      </SubSteps>
    </>
  );
}

function StepInstall() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <SubSteps>
      {[
        <>
          {tI18nComplete.raw('textf2da697d0ec4')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('text7f717f55d7c2')}</SlackUiLabel>{' '}
          {tI18nComplete.raw('text3ccc48a02ff4')}
        </>,
        <>
          {tI18nComplete.raw('text95ba4ed9329f')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('text52141cfb5b12')}</SlackUiLabel>.
        </>,
        <>
          {tI18nComplete.raw('text3022f99399d7')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('texte213c161d5ce')}</SlackUiLabel>.
        </>,
      ]}
    </SubSteps>
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
        <p className="text-xs/relaxed text-muted-foreground">
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
        <p className="text-xs/relaxed text-muted-foreground">
          {tI18nComplete.raw('text74783b066cae')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('textd094b334d809')}</SlackUiLabel> →{' '}
          <SlackUiLabel>{tI18nComplete.raw('texta489d605af5a')}</SlackUiLabel> →{' '}
          <SlackUiLabel>{tI18nComplete.raw('textf5e81453d0e9')}</SlackUiLabel>
          {tI18nComplete.raw('text438812ba8432')}{' '}
          <SlackUiLabel>{tI18nComplete.raw('text0df6f1cad36c')}</SlackUiLabel>{' '}
          {tI18nComplete.raw('text9a91c10f08c8')}
        </p>
      </div>

      {/* The lock says what the info glyph cannot: these values are sealed. */}
      <Alert>
        <AlertMedia>
          <LockIcon className="text-kortix-blue" weight="fill" />
        </AlertMedia>
        <AlertDescription>{tI18nComplete.raw('texte4fbfdfe7290')}</AlertDescription>
      </Alert>

      {error ? (
        <InfoBanner tone="destructive" title={tI18nComplete.raw('text8630b4dd33f2')}>
          {error}
        </InfoBanner>
      ) : null}
    </>
  );
}
