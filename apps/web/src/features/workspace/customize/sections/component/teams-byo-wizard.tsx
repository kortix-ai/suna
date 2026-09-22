'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * "Use your own Microsoft Teams app" — the self-hosted / custom-bot install
 * path, as a guided three-step wizard in a Modal.
 *
 * ## Why the step ORDER differs from Slack's
 *
 * `slack-byo-wizard.tsx` goes create → install → paste, because Slack's
 * manifest is app-independent: you can copy it before the app exists. Teams
 * cannot work that way. `GET /channels/teams/manifest` builds the manifest
 * from `mode.appId`, which for a bring-your-own bot is
 * `loadTeamsAppIdForProject(projectId)` — the id stored by **connect**. Ask
 * for the manifest first and it either 409s or hands back the managed app's
 * id, which is the wrong bot.
 *
 * So the order is register → connect → upload:
 *
 * 1. **Register the bot in Azure.** The one thing needed up front is the
 *    messaging endpoint, and that is knowable before connect.
 * 2. **Connect it to this project.** The commit step: app id, client secret,
 *    tenant id. `useConnectTeams` already invalidates the manifest query on
 *    success, so step 3 renders the manifest for *this* bot with no extra
 *    plumbing.
 * 3. **Upload the app to Teams.** Only now does a correct manifest exist.
 *
 * ## What this gives a BYO user that the panel did not
 *
 * `teams-channel-panel.tsx` renders `ManifestCopyBlock` under
 * `managedAvailable && !byo` — so in bring-your-own mode the manifest is
 * hidden outright and there is no upload step at all. A BYO admin had to know
 * to run `kortix channels manifest --platform teams` from a terminal. Step 3
 * is that missing half of the flow.
 *
 * ## The messaging endpoint before connect
 *
 * `teamsMode()` only returns the per-project webhook
 * (`/v1/webhooks/teams/:projectId/messages`) once a BYO app id is stored; before
 * that it returns the shared managed one. Pointing an Azure bot at the shared
 * endpoint would send its traffic to the managed app's handler, so the
 * endpoint is derived here by rewriting the tail the server gave us. Deriving
 * it from the server's own value keeps the origin right on every deployment
 * (dev, preview, self-host) without the client knowing the API base.
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
import {
  useConnectTeams,
  useTeamsManifest,
  type TeamsMode,
} from '@/hooks/channels/use-teams-installations';
import { cn } from '@/lib/utils';
import { CheckIcon, ArrowSquareOutIcon as ExternalLinkIcon, LockIcon } from '@phosphor-icons/react';
import { m } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';

const AZURE_NEW_BOT_URL =
  'https://portal.azure.com/#create/Microsoft.AzureBot';
const TEAMS_ADMIN_APPS_URL = 'https://admin.teams.microsoft.com/policies/manage-apps';

type StepNumber = 1 | 2 | 3;

/** A numbered sub-instruction inside a step — one action, one line. */
function SubStep({ children }: { children: React.ReactNode }) {
  return <li className="text-muted-foreground text-sm leading-relaxed">{children}</li>;
}

/**
 * The endpoint an Azure bot must post to for THIS project. See the note at the
 * top: the server's value is the managed one until a BYO app id exists.
 */
export function byoMessagingEndpoint(
  serverEndpoint: string | null | undefined,
  projectId: string,
): string | null {
  if (!serverEndpoint) return null;
  return serverEndpoint.replace(
    /\/v1\/webhooks\/teams\/messages$/,
    `/v1/webhooks/teams/${projectId}/messages`,
  );
}

export function TeamsByoWizard({
  projectId,
  mode,
  open,
  onOpenChange,
}: {
  projectId: string;
  mode: TeamsMode | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [step, setStep] = useState<StepNumber>(1);
  const [appId, setAppId] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connect = useConnectTeams();
  const manifest = useTeamsManifest(projectId);
  const endpoint = byoMessagingEndpoint(mode?.messagingEndpoint, projectId);

  const steps = [
    { step: 1 as const, title: tI18nComplete.raw('text7f1b55a356b0') },
    { step: 2 as const, title: tI18nComplete.raw('text91004edf8b30') },
    { step: 3 as const, title: tI18nComplete.raw('text6014c20ee34a') },
  ];

  const credentialsFilled =
    appId.trim().length > 0 && appPassword.trim().length > 0 && tenantId.trim().length > 0;

  const submit = () => {
    setError(null);
    connect.mutate(
      {
        projectId,
        tenant_id: tenantId.trim(),
        app_id: appId.trim(),
        app_password: appPassword.trim(),
      },
      {
        onSuccess: () => {
          successToast(tI18nComplete.raw('text5df0a8e1f30f'));
          // Not closed here on purpose: the manifest only becomes correct once
          // connect has stored the app id, so step 3 is the payoff for step 2.
          setStep(3);
        },
        onError: (e) =>
          setError(e instanceof Error ? e.message : tI18nComplete.raw('text98722a5463cb')),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-xl">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('texte2065cb79c86')}</ModalTitle>
          <ModalDescription>{tI18nComplete.raw('text3312ddb06c1d')}</ModalDescription>
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
                          <StepRegisterBot endpoint={endpoint} onNext={() => setStep(2)} />
                        ) : null}
                        {n === 2 ? (
                          <StepCredentials
                            appId={appId}
                            appPassword={appPassword}
                            tenantId={tenantId}
                            onAppIdChange={setAppId}
                            onAppPasswordChange={setAppPassword}
                            onTenantIdChange={setTenantId}
                            error={error}
                          />
                        ) : null}
                        {n === 3 ? (
                          <StepUpload
                            manifestText={manifest.data ?? ''}
                            loading={manifest.isLoading}
                            error={manifest.error instanceof Error ? manifest.error.message : null}
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

        {/* Step 2 is the commit and step 3 is its receipt, so both get the
            modal footer. Step 1 advances from inside its own body, where the
            button sits next to the instruction it confirms. */}
        {step === 2 ? (
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => setStep(1)}>
              {tI18nComplete.raw('text76900f1bfd16')}
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={connect.isPending || !credentialsFilled}
            >
              {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('text5df0a8e1f30f')}
            </Button>
          </ModalFooter>
        ) : null}
        {step === 3 ? (
          <ModalFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              {tI18nComplete.raw('text11a6767d5674')}
            </Button>
          </ModalFooter>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function StepRegisterBot({ endpoint, onNext }: { endpoint: string | null; onNext: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {tI18nComplete.raw('text22891df1ec93')}
      </p>

      {/* `language="text"` is why ManifestCopyBlock takes the prop — its own
          comment says "a prop so Teams could differ". One URL, one copy
          control, named by what it is. */}
      <ManifestCopyBlock
        text={endpoint ?? ''}
        filename={tI18nComplete.raw('text8dcb943dc3b2')}
        language="text"
        loading={false}
        error={null}
      />

      <div className="flex flex-col items-start gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" asChild>
          <Link href={AZURE_NEW_BOT_URL} target="_blank" rel="noopener noreferrer">
            {tI18nComplete.raw('text2dd53600f505')}
            <ExternalLinkIcon className="size-3.5 shrink-0" />
          </Link>
        </Button>
      </div>

      <ol className="list-decimal space-y-1.5 pl-5">
        <SubStep>{tI18nComplete.raw('text8eb37da4b2df')}</SubStep>
        <SubStep>{tI18nComplete.raw('textf8a542d3c304')}</SubStep>
        <SubStep>{tI18nComplete.raw('text4587dfe8ba37')}</SubStep>
      </ol>

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={onNext}>
          {tI18nComplete.raw('text97fa07f21de8')}
        </Button>
      </div>
    </>
  );
}

function StepCredentials({
  appId,
  appPassword,
  tenantId,
  onAppIdChange,
  onAppPasswordChange,
  onTenantIdChange,
  error,
}: {
  appId: string;
  appPassword: string;
  tenantId: string;
  onAppIdChange: (v: string) => void;
  onAppPasswordChange: (v: string) => void;
  onTenantIdChange: (v: string) => void;
  error: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="teams-byo-app-id">{tI18nComplete.raw('text576111a7aee1')}</Label>
        <Input
          id="teams-byo-app-id"
          placeholder="00000000-0000-0000-0000-000000000000"
          value={appId}
          onChange={(e) => onAppIdChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {tI18nComplete.raw('textf68f19d4f41b')}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="teams-byo-app-password">{tI18nComplete.raw('text4aded5faf156')}</Label>
        <Input
          id="teams-byo-app-password"
          type="password"
          placeholder="••••••••"
          value={appPassword}
          onChange={(e) => onAppPasswordChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {tI18nComplete.raw('text39eba5dfad95')}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="teams-byo-tenant-id">{tI18nComplete.raw('text1dc4abe27594')}</Label>
        <Input
          id="teams-byo-tenant-id"
          placeholder="00000000-0000-0000-0000-000000000000"
          value={tenantId}
          onChange={(e) => onTenantIdChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {tI18nComplete.raw('texte9c014cbed45')}
        </p>
      </div>

      <div className="text-muted-foreground flex items-start gap-2 text-xs leading-relaxed">
        <LockIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>{tI18nComplete.raw('text8dd795841572')}</span>
      </div>

      {error ? (
        <InfoBanner tone="destructive" title={tI18nComplete.raw('text98722a5463cb')}>
          {error}
        </InfoBanner>
      ) : null}
    </>
  );
}

function StepUpload({
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
      <p className="text-muted-foreground text-sm leading-relaxed">
        {tI18nComplete.raw('text408bab8e8be6')}
      </p>

      <ManifestCopyBlock
        text={manifestText}
        filename="manifest.json"
        loading={loading}
        error={error}
      />

      <div className="flex flex-col items-start gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" asChild>
          <Link href={TEAMS_ADMIN_APPS_URL} target="_blank" rel="noopener noreferrer">
            {tI18nComplete.raw('textd208e2f1260f')}
            <ExternalLinkIcon className="size-3.5 shrink-0" />
          </Link>
        </Button>
      </div>

      <ol className="list-decimal space-y-1.5 pl-5">
        <SubStep>{tI18nComplete.raw('text843ed3b90b42')}</SubStep>
        <SubStep>{tI18nComplete.raw('text5c71673648a2')}</SubStep>
        <SubStep>{tI18nComplete.raw('text91b9932411cc')}</SubStep>
      </ol>
    </>
  );
}
