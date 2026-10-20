'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * "Use your own Microsoft Teams app" — the self-hosted / custom-bot install
 * path, as a guided three-step wizard in a two-pane Modal: a rail that names
 * the flow and lists the steps, and a pane that holds the active step.
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

import { CopyButton } from '@/components/markdown/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { ModalDescription, ModalTitle } from '@/components/ui/modal';
import { ByoWizardModal } from './byo-wizard-modal';
import {
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { successToast } from '@/components/ui/toast';
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import {
  useConnectTeams,
  useTeamsManifest,
  type TeamsMode,
} from '@/hooks/channels/use-teams-installations';
import { cn } from '@/lib/utils';
import {
  ArrowUpRightIcon,
  CheckIcon,
  DownloadSimpleIcon,
  FileCodeIcon,
} from '@phosphor-icons/react';
import { m } from 'motion/react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

const AZURE_NEW_BOT_URL = 'https://portal.azure.com/#create/Microsoft.AzureBot';
const TEAMS_ADMIN_APPS_URL = 'https://admin.teams.microsoft.com/policies/manage-apps';
const MANIFEST_FILENAME = 'manifest.json';
/** Microsoft's Azure brand blues — a third-party mark, not a Kortix token. */
const AZURE_BRAND = { deep: '#0a5fb5', base: '#0078d4', light: '#1490df' } as const;

type StepNumber = 1 | 2 | 3;

/**
 * The endpoint an Azure bot must post to for THIS project. See the note at the
 * top: the server's value is the managed one until a BYO app id exists.
 */
function byoMessagingEndpoint(
  serverEndpoint: string | null | undefined,
  projectId: string,
): string | null {
  if (!serverEndpoint) return null;
  return serverEndpoint.replace(
    /\/v1\/webhooks\/teams\/messages$/,
    `/v1/webhooks/teams/${projectId}/messages`,
  );
}

/** Azure's mark, flat. Only this wizard needs it, so it lives here. */
function AzureMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden className={className}>
      <path
        fill={AZURE_BRAND.deep}
        d="M33.3 6.5h26.7L32.3 88.6a4.3 4.3 0 0 1-4 2.9H7.5a4.2 4.2 0 0 1-4-5.6L29.3 9.4a4.3 4.3 0 0 1 4-2.9"
      />
      <path
        fill={AZURE_BRAND.base}
        d="M72.2 61.5H29.9a2 2 0 0 0-1.3 3.4l27.2 25.4a4.3 4.3 0 0 0 2.9 1.1h24z"
      />
      <path
        fill={AZURE_BRAND.light}
        d="M66.6 9.4a4.3 4.3 0 0 0-4-2.9H32.9a4.3 4.3 0 0 1 4 2.9l25.9 76.6a4.2 4.2 0 0 1-4 5.6h29.8a4.2 4.2 0 0 0 4-5.6z"
      />
    </svg>
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
  const leads: Record<StepNumber, string> = {
    1: tI18nComplete.raw('text22891df1ec93'),
    2: tI18nComplete.raw('textfd326bb01b61'),
    3: tI18nComplete.raw('text408bab8e8be6'),
  };

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
    <ByoWizardModal
      platform="teams"
      open={open}
      onOpenChange={onOpenChange}
      step={step}
      setStep={setStep}
      count={steps.length}
      header={
          <div className="space-y-3">
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <MicrosoftTeams className="size-5" />
              {tI18nComplete.raw('texta7b52b269a23')}
            </div>
            <ModalTitle className="text-xl font-medium text-balance">
              {tI18nComplete.raw('texte2065cb79c86')}
            </ModalTitle>
            <ModalDescription className="leading-relaxed text-pretty">
              {tI18nComplete.raw('text3312ddb06c1d')}
            </ModalDescription>
          </div>
      }
      steps={
        <>
            {steps.map(({ step: n, title }) => (
              <div key={n} className="flex gap-3">
                {/* Only completed steps are re-visitable; jumping ahead would
                    skip the confirmation each step exists to collect. */}
                <StepperItem step={n} disabled={n > step} className="items-center">
                  <StepperTrigger className="flex shrink-0">
                    <StepperIndicator className="tabular-nums">
                      {n < step ? <CheckIcon className="size-3" /> : n}
                    </StepperIndicator>
                  </StepperTrigger>
                  <StepperSeparator className="bg-border m-0 my-1 group-data-[orientation=vertical]/stepper:min-h-5" />
                </StepperItem>
                <StepperTitle
                  className={cn(
                    'pt-0.5 font-normal transition-colors',
                    n < steps.length && 'pb-6',
                    n === step ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {title}
                </StepperTitle>
              </div>
            ))}
        </>
      }
      footer={
        <>
            {step === 1 ? (
              <>
                <p className="text-muted-foreground text-xs text-pretty">
                  {tI18nComplete.raw('textbda0f959cde0')}
                </p>
                <Button type="button" onClick={() => setStep(2)}>
                  {tI18nComplete.raw('text97fa07f21de8')}
                </Button>
              </>
            ) : null}
            {step === 2 ? (
              <>
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
              </>
            ) : null}
            {step === 3 ? (
              <Button type="button" className="ms-auto" onClick={() => onOpenChange(false)}>
                {tI18nComplete.raw('text11a6767d5674')}
              </Button>
            ) : null}
        </>
      }
    >
          {/* Step 1 is the tallest step, so it sets the pane's minimum height:
              an invisible, inert copy shares the grid cell with the active
              step, and the modal no longer shrinks when the user moves on. */}
          <div className="grid flex-1 overflow-y-auto lg:max-h-[70vh]">
            {step !== 1 ? (
              <div inert aria-hidden className="invisible col-start-1 row-start-1 space-y-5 p-6">
                <StepHeader title={steps[0].title} lead={leads[1]} />
                <StepRegisterBot endpoint={endpoint} />
              </div>
            ) : null}
            <m.div
              key={step}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              className="col-start-1 row-start-1 space-y-5 p-6"
            >
              <StepHeader title={steps[step - 1].title} lead={leads[step]} />

              {step === 1 ? <StepRegisterBot endpoint={endpoint} /> : null}
              {step === 2 ? (
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
              {step === 3 ? (
                <StepUpload
                  manifestText={manifest.data ?? ''}
                  loading={manifest.isLoading}
                  error={manifest.error instanceof Error ? manifest.error.message : null}
                />
              ) : null}
            </m.div>
          </div>
    </ByoWizardModal>
  );
}

function StepHeader({ title, lead }: { title: string; lead: string }) {
  return (
    <header className="space-y-1 pe-8">
      <h2 className="text-lg font-medium text-balance">{title}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed text-pretty">{lead}</p>
    </header>
  );
}

/** A bordered card of numbered actions to take in another product. */
function InstructionCard({
  icon,
  title,
  action,
  items,
}: {
  icon: ReactNode;
  title: string;
  action: ReactNode;
  items: string[];
}) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        {action}
      </div>
      <ol className="space-y-2 px-4 pt-3 pb-4">
        {items.map((item, i) => (
          <li key={item} className="flex gap-3 text-sm leading-relaxed">
            <span className="text-muted-foreground w-3 shrink-0 tabular-nums">{i + 1}</span>
            <span className="text-pretty">{item}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button size="sm" variant="outline" className="shrink-0" asChild>
      <Link href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ArrowUpRightIcon className="size-3.5 shrink-0" />
      </Link>
    </Button>
  );
}

function StepRegisterBot({ endpoint }: { endpoint: string | null }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      <div className="space-y-2">
        <Label>{tI18nComplete.raw('text8dcb943dc3b2')}</Label>
        <div className="bg-secondary flex items-center gap-2 rounded-lg border py-1.5 ps-3 pe-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={endpoint ?? undefined}>
            {endpoint}
          </code>
          {endpoint ? <CopyButton code={endpoint} size="sm" /> : null}
        </div>
      </div>

      <InstructionCard
        icon={<AzureMark className="size-4" />}
        title={tI18nComplete.raw('text39864856b1bc')}
        action={
          <ExternalButton href={AZURE_NEW_BOT_URL}>
            {tI18nComplete.raw('text2dd53600f505')}
          </ExternalButton>
        }
        items={[
          tI18nComplete.raw('text8eb37da4b2df'),
          tI18nComplete.raw('textf8a542d3c304'),
          tI18nComplete.raw('text4587dfe8ba37'),
        ]}
      />
    </>
  );
}

function CredentialField({
  id,
  label,
  hint,
  value,
  onChange,
  secret = false,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={secret ? 'password' : 'text'}
        placeholder={secret ? '••••••••' : '00000000-0000-0000-0000-000000000000'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{hint}</p>
    </div>
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
      <CredentialField
        id="teams-byo-app-id"
        label={tI18nComplete.raw('text576111a7aee1')}
        hint={tI18nComplete.raw('textf68f19d4f41b')}
        value={appId}
        onChange={onAppIdChange}
      />
      <CredentialField
        id="teams-byo-app-password"
        label={tI18nComplete.raw('text4aded5faf156')}
        hint={tI18nComplete.raw('text39eba5dfad95')}
        value={appPassword}
        onChange={onAppPasswordChange}
        secret
      />
      <CredentialField
        id="teams-byo-tenant-id"
        label={tI18nComplete.raw('text1dc4abe27594')}
        hint={tI18nComplete.raw('texte9c014cbed45')}
        value={tenantId}
        onChange={onTenantIdChange}
      />

      <Alert>
        <AlertDescription>{tI18nComplete.raw('text8dd795841572')}</AlertDescription>
      </Alert>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{tI18nComplete.raw('text98722a5463cb')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  const ready = !loading && !error && manifestText.length > 0;
  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <span className="bg-secondary text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md">
          <FileCodeIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm">{MANIFEST_FILENAME}</p>
          <p
            className={cn('truncate text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
          >
            {error ?? tI18nComplete.raw('text9bd6f94da702')}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={!ready}
          onClick={() => downloadText(manifestText, MANIFEST_FILENAME)}
        >
          {loading ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <DownloadSimpleIcon className="size-3.5 shrink-0" />
          )}
          {tI18nComplete.raw('textd6eafe823591')}
        </Button>
      </div>

      <InstructionCard
        icon={<MicrosoftTeams className="size-4" />}
        title={tI18nComplete.raw('text14bb4b708203')}
        action={
          <ExternalButton href={TEAMS_ADMIN_APPS_URL}>
            {tI18nComplete.raw('textd208e2f1260f')}
          </ExternalButton>
        }
        items={[
          tI18nComplete.raw('text843ed3b90b42'),
          tI18nComplete.raw('text5c71673648a2'),
          tI18nComplete.raw('text91b9932411cc'),
        ]}
      />
    </>
  );
}
