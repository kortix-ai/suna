'use client';

import { useTranslations } from 'next-intl';

import { useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, Slack, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { getEnv } from '@/lib/env-config';
import {
  useSlackInstall,
  useSlackMode,
  useConnectSlack,
  useDisconnectSlack,
  type SlackInstallation,
} from '@/hooks/channels/use-channels-installations';

interface ChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
}

export function ChannelsDialog({ open, onOpenChange, projectId }: ChannelsDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);
  const { data: mode, isLoading: loadingMode } = useSlackMode(projectId);
  const loading = loadingInstall || loadingMode;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Slack className="h-4 w-4" />
            Channels
          </DialogTitle>
          <DialogDescription>{tHardcodedUi.raw('componentsChannelsChannelsDialog.line46JsxTextConnectSlackSoTheAgentCanPostInto')}</DialogDescription>
        </DialogHeader>

        {!projectId ? (
          <div className="rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line52JsxTextOpenAProjectToManageItsSlackConnection')}</div>
        ) : loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />{tHardcodedUi.raw('componentsChannelsChannelsDialog.line57JsxTextLoading')}</div>
        ) : install ? (
          <Connected projectId={projectId} installation={install} />
        ) : (
          <NotConnected
            projectId={projectId}
            oauthInstallUrl={mode?.oauth_available ? mode.install_url : null}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NotConnected({
  projectId,
  oauthInstallUrl,
}: {
  projectId: string;
  oauthInstallUrl: string | null;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [showByo, setShowByo] = useState(!oauthInstallUrl);

  if (!oauthInstallUrl) {
    return <SelfInstall projectId={projectId} />;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/70 bg-card px-4 py-4">
        <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line88JsxTextAddKortixToYourSlackWorkspace')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line90JsxTextOneClickApproveScopesInSlackAndWe')}</p>
        <div className="mt-3">
          <a href={oauthInstallUrl} target="_blank" rel="noopener noreferrer" className="inline-flex">
            <Button size="sm" className="gap-1.5">
              <Slack className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsChannelsChannelsDialog.line96JsxTextAddToSlack')}<ExternalLink className="h-3 w-3" />
            </Button>
          </a>
        </div>
      </div>

      {showByo ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowByo(false)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >{tHardcodedUi.raw('componentsChannelsChannelsDialog.line110JsxTextHideAdvanced')}</button>
          <SelfInstall projectId={projectId} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowByo(true)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >{tHardcodedUi.raw('componentsChannelsChannelsDialog.line120JsxTextAdvancedBringYourOwnSlackApp')}</button>
      )}
    </div>
  );
}

function Connected({
  projectId,
  installation,
}: {
  projectId: string;
  installation: SlackInstallation;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-4">
      <InfoBanner
        tone="success"
        icon={Check}
        title={`Connected to ${installation.workspaceName ?? installation.workspaceId}`}
      >{tHardcodedUi.raw('componentsChannelsChannelsDialog.line144JsxTextBotUser')}<code className="font-mono">{installation.botUserId ?? '—'}</code>{tHardcodedUi.raw('componentsChannelsChannelsDialog.line144JsxTextTeam')}{' '}
        <code className="font-mono">{installation.workspaceId}</code>
      </InfoBanner>

      <div className="rounded-2xl border border-border/70 bg-card px-4 py-3 text-sm">
        <p className="font-medium text-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line149JsxTextNextEnableForThisProject')}</p>
        <p className="mt-1 text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line151JsxTextInviteTheBotToAChannelAnd')}<code className="font-mono text-xs">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line151JsxTextMention')}</code>{tHardcodedUi.raw('componentsChannelsChannelsDialog.line151JsxTextItASessionSpawnsInThisProjectS')}{' '}
          <code className="font-mono text-xs">slack</code> CLI.
        </p>
      </div>

      <div className="flex items-center justify-end pt-1">
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line161JsxTextRemovesTheSecretsAndStopsEventsForThis')}</span>
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
          </div>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [step, setStep] = useState<1 | 2>(1);
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectSlack();

  const manifest = useMemo(() => buildSlackManifest(projectId), [projectId]);

  const copyManifest = async () => {
    if (!manifest) return;
    await navigator.clipboard.writeText(manifest);
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
      {
        onError: (e) => setError((e as Error).message),
      },
    );
  };

  if (step === 1) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line226JsxTextStep1Of2PasteTheManifestInto')}</p>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line233JsxTextAppManifest')}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={copyManifest}
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
                <Button variant="outline" size="sm" className="h-7 gap-1.5">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line252JsxTextOpenSlack')}<ExternalLink className="h-3 w-3" />
                </Button>
              </a>
            </div>
          </div>
          <pre
            className={cn(
              'max-h-64 overflow-auto rounded-2xl border border-border bg-muted/30 p-3 text-xs leading-relaxed',
            )}
          >
            {manifest}
          </pre>
        </div>

        <ol className="space-y-1.5 text-sm">
          {[
            'Click Open Slack, choose "From a manifest", paste the JSON, confirm.',
            'On the next screen, click Install to Workspace and approve.',
            'Copy the Bot User OAuth Token (xoxb-…) and Signing Secret.',
          ].map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                {i + 1}
              </span>
              <span className="text-muted-foreground">{step}</span>
            </li>
          ))}
        </ol>

        <div className="flex justify-end">
          <Button onClick={() => setStep(2)}>{tHardcodedUi.raw('componentsChannelsChannelsDialog.line283JsxTextNextPasteTokens')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line292JsxTextStep2Of2PasteTheTwoValues')}<code className="font-mono text-xs">project_secrets</code>{tHardcodedUi.raw('componentsChannelsChannelsDialog.line293JsxTextAlongsideAnyOtherSecretsTheProjectUses')}</p>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="bot-token">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line299JsxTextBotUserOauthToken')}</Label>
          <Input
            id="bot-token"
            placeholder={tHardcodedUi.raw('componentsChannelsChannelsDialog.line302JsxAttrPlaceholderXoxb')}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line309JsxTextSlackYourAppOauthPermissionsBotUserOauth')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signing-secret">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line313JsxTextSigningSecret')}</Label>
          <Input
            id="signing-secret"
            placeholder="••••••••"
            type="password"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsChannelsChannelsDialog.line324JsxTextSlackYourAppBasicInformationAppCredentialsSigning')}</p>
        </div>
      </div>

      {error ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => setStep(1)}>
          Back
        </Button>
        <Button
          onClick={submit}
          disabled={connect.isPending || !botToken.trim() || !signingSecret.trim()}
        >
          {connect.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{tHardcodedUi.raw('componentsChannelsChannelsDialog.line344JsxTextConnectSlack')}</Button>
      </div>
    </div>
  );
}

function buildSlackManifest(projectId: string): string {
  const backendUrl = (getEnv().BACKEND_URL ?? '').replace(/\/$/, '');
  const requestUrl = backendUrl
    ? `${backendUrl}/v1/webhooks/slack/${projectId}`
    : `<set BACKEND_URL in env>/v1/webhooks/slack/${projectId}`;
  const manifest = {
    display_information: {
      name: 'Kortix',
      description: 'Run a Kortix project from Slack',
      background_color: '#0a0a0a',
    },
    features: { bot_user: { display_name: 'kortix', always_online: true } },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'channels:history',
          'channels:read',
          'channels:join',
          'chat:write',
          'chat:write.public',
          'files:read',
          'files:write',
          'groups:history',
          'groups:read',
          'im:history',
          'im:read',
          'im:write',
          'mpim:history',
          'mpim:read',
          'reactions:read',
          'reactions:write',
          'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          'app_mention',
          'message.im',
          'message.channels',
          'message.groups',
          'message.mpim',
          'reaction_added',
          'reaction_removed',
          'member_joined_channel',
          'file_shared',
        ],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}
