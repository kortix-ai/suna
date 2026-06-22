'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useConnectSlack,
  useDisconnectSlack,
  useSlackInstall,
  useSlackManifest,
  useSlackMode,
  type SlackInstallation,
} from '@/hooks/channels/use-channels-installations';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, Copy, ExternalLink, Loader2, Slack, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import CustomizeSectionWrapper from '../component/section-wrapper';

export function ChannelsView({ projectId }: { projectId: string | null }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);
  const { data: mode, isLoading: loadingMode } = useSlackMode(projectId);
  const loading = loadingInstall || loadingMode;

  return (
    <CustomizeSectionWrapper
      title="Channels"
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextRunThisb83f74db',
      )}
    >
      {!projectId ? (
        <InfoBanner tone="neutral">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOpenA4ae69220',
          )}
        </InfoBanner>
      ) : loading ? (
        <Skeleton className="h-32 w-full rounded-2xl" />
      ) : install ? (
        <ConnectedPanel projectId={projectId} installation={install} />
      ) : (
        <DisconnectedPanel
          projectId={projectId}
          oauthInstallUrl={mode?.oauth_available ? mode.install_url : null}
        />
      )}
    </CustomizeSectionWrapper>
  );
}

function DisconnectedPanel({
  projectId,
  oauthInstallUrl,
}: {
  projectId: string;
  oauthInstallUrl: string | null;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [showByo, setShowByo] = useState(!oauthInstallUrl);

  if (!oauthInstallUrl) {
    return (
      <SectionCard
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrTitleBringbd0857f4',
        )}
        description={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrDescriptionSelf843645ea',
        )}
      >
        <SelfInstall projectId={projectId} />
      </SectionCard>
    );
  }

  return (
    <SectionCard flush>
      <div className="flex flex-col items-start gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="border-border/60 bg-muted/40 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
            <Slack className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAddKortix0e416aa2',
              )}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOneClick68f102dc',
              )}
            </p>
          </div>
        </div>
        <a
          href={oauthInstallUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0"
        >
          <Button size="sm" className="gap-1.5">
            <Slack className="h-3.5 w-3.5" />
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAddTo1729c1b6',
            )}
            <ExternalLink className="h-3 w-3" />
          </Button>
        </a>
      </div>

      <button
        type="button"
        onClick={() => setShowByo((v) => !v)}
        className="border-border/60 hover:bg-muted/30 flex w-full items-center justify-between gap-3 border-t px-6 py-3 text-left transition-colors"
        aria-expanded={showByo}
      >
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextBringYourc7326733',
            )}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextForSelf3fbeca22',
            )}
          </p>
        </div>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            showByo && 'rotate-180',
          )}
        />
      </button>
      {showByo && (
        <div className="border-border/60 border-t px-6 py-5">
          <SelfInstall projectId={projectId} />
        </div>
      )}
    </SectionCard>
  );
}

function ConnectedPanel({
  projectId,
  installation,
}: {
  projectId: string;
  installation: SlackInstallation;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-4">
      <InfoBanner
        tone="success"
        icon={Check}
        title={`Connected to ${installation.workspaceName ?? installation.workspaceId}`}
      >
        Bot <code className="font-mono">{installation.botUserId ?? '—'}</code>
        {' · '}Team <code className="font-mono">{installation.workspaceId}</code>
      </InfoBanner>

      <SectionCard
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrTitleHow8e991872',
        )}
      >
        <p className="text-muted-foreground text-sm">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextInviteThe94db1964',
          )}{' '}
          <code className="font-mono text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextMention67ed74a7',
            )}
          </code>{' '}
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextItA7139ed4f',
          )}{' '}
          <code className="font-mono text-xs">slack</code> CLI.
        </p>
      </SectionCard>

      <div className="flex items-center justify-end gap-2">
        {confirming ? (
          <>
            <span className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextRemovesTheb460240b',
              )}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(projectId, {
                  onSuccess: () => setConfirming(false),
                })
              }
            >
              {disconnect.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

function SelfInstall({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [step, setStep] = useState<1 | 2>(1);
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectSlack();
  const manifest = useSlackManifest(projectId);

  const manifestText = manifest.data ?? '';

  const copyManifest = async () => {
    if (!manifestText) return;
    await navigator.clipboard.writeText(manifestText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const submit = () => {
    setError(null);
    connect.mutate(
      {
        projectId,
        bot_token: botToken.trim(),
        signing_secret: signingSecret.trim(),
      },
      { onError: (e) => setError((e as Error).message) },
    );
  };

  if (step === 1) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextStep12c389f4e',
          )}
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAppManifest040b924e',
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={copyManifest}
                disabled={!manifestText}
                className="h-7 gap-1.5"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <a
                href="https://api.slack.com/apps?new_app=1"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
              >
                <Button variant="outline" size="sm" className="h-7 gap-1.5">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOpenSlacka088997c',
                  )}
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </a>
            </div>
          </div>
          <pre className="border-border bg-muted/30 max-h-64 overflow-auto rounded-2xl border p-3 text-xs leading-relaxed">
            {manifest.isLoading
              ? 'Loading manifest...'
              : manifest.error
                ? `Failed to load manifest: ${(manifest.error as Error).message}`
                : manifestText}
          </pre>
        </div>

        <ol className="space-y-1.5 text-sm">
          {[
            'Click Open Slack, choose "From a manifest", paste the JSON, confirm.',
            'On the next screen, click Install to Workspace and approve.',
            'Copy the Bot User OAuth Token (xoxb-…) and Signing Secret.',
          ].map((line, i) => (
            <li key={i} className="flex gap-3">
              <span className="bg-muted text-muted-foreground mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                {i + 1}
              </span>
              <span className="text-muted-foreground">{line}</span>
            </li>
          ))}
        </ol>

        <div className="flex justify-end">
          <Button size="sm" onClick={() => setStep(2)}>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextNextPasted1384aaa',
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextStep22f8cae80',
        )}{' '}
        <code className="font-mono text-xs">project_secrets</code>{' '}
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAlongsideAny8e77bd03',
        )}
      </p>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="bot-token">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextBotUser193e4bfd',
            )}
          </Label>
          <Input
            id="bot-token"
            placeholder={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrPlaceholderXoxb84fe69f4',
            )}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSlackYouraeeca6ed',
            )}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signing-secret">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSigningSecret2762795e',
            )}
          </Label>
          <Input
            id="signing-secret"
            placeholder="••••••••"
            type="password"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSlackYour09fe8ce8',
            )}
          </p>
        </div>
      </div>

      {error ? (
        <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-2xl border px-3 py-2 text-xs">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
          Back
        </Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={connect.isPending || !botToken.trim() || !signingSecret.trim()}
        >
          {connect.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextConnectSlack5ad82c3b',
          )}
        </Button>
      </div>
    </div>
  );
}
