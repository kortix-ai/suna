'use client';

import { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Slack,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getEnv } from '@/lib/env-config';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import {
  useSlackInstall,
  useSlackMode,
  useConnectSlack,
  useDisconnectSlack,
  type SlackInstallation,
} from '@/hooks/channels/use-channels-installations';


export function ChannelsView({ projectId }: { projectId: string | null }) {
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);
  const { data: mode, isLoading: loadingMode } = useSlackMode(projectId);
  const loading = loadingInstall || loadingMode;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CustomizeSectionHeader icon={Slack} title="Channels" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
          <header className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">Channels</h2>
            <p className="text-xs text-muted-foreground">
              Run this project from chat — connect a Slack workspace and your agent
              responds in the channels you invite it to.
            </p>
          </header>

          {!projectId ? (
            <InfoBanner tone="neutral">
              Open a project to manage its Slack connection.
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
        </div>
      </div>
    </div>
  );
}

function DisconnectedPanel({
  projectId,
  oauthInstallUrl,
}: {
  projectId: string;
  oauthInstallUrl: string | null;
}) {
  const [showByo, setShowByo] = useState(!oauthInstallUrl);

  if (!oauthInstallUrl) {
    return (
      <SectionCard
        title="Bring your own Slack app"
        description="Self-hosted setups don't have OAuth wired up — paste a manifest and tokens to finish the install. Stored encrypted in this project's secrets."
      >
        <SelfInstall projectId={projectId} />
      </SectionCard>
    );
  }

  return (
    <SectionCard flush>
      <div className="flex flex-col items-start gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/40">
            <Slack className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Add Kortix to your Slack workspace
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              One click — approve scopes in Slack and we&apos;ll wire this project
              to the workspace you choose. Tokens stay encrypted in this project&apos;s secrets.
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
            Add to Slack
            <ExternalLink className="h-3 w-3" />
          </Button>
        </a>
      </div>

      <button
        type="button"
        onClick={() => setShowByo((v) => !v)}
        className="flex w-full items-center justify-between gap-3 border-t border-border/60 px-6 py-3 text-left transition-colors hover:bg-muted/30"
        aria-expanded={showByo}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Bring your own Slack app
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            For self-hosted setups or custom-scoped installs.
          </p>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            showByo && 'rotate-180',
          )}
        />
      </button>
      {showByo && (
        <div className="border-t border-border/60 px-6 py-5">
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

      <SectionCard title="How to use">
        <p className="text-sm text-muted-foreground">
          Invite the bot to any channel and{' '}
          <code className="font-mono text-xs">@mention</code> it. A session spawns
          in this project&apos;s sandbox and the agent replies in-thread via the{' '}
          <code className="font-mono text-xs">slack</code> CLI.
        </p>
      </SectionCard>

      <div className="flex items-center justify-end gap-2">
        {confirming ? (
          <>
            <span className="text-xs text-muted-foreground">
              Removes the secrets and stops events for this project.
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
              {disconnect.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : null}
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
      { onError: (e) => setError((e as Error).message) },
    );
  };

  if (step === 1) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Step 1 of 2 — paste the manifest into Slack and install the app.
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              App manifest
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={copyManifest}
                className="h-7 gap-1.5"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <a
                href="https://api.slack.com/apps?new_app=1"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
              >
                <Button variant="outline" size="sm" className="h-7 gap-1.5">
                  Open Slack
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </a>
            </div>
          </div>
          <pre className="max-h-64 overflow-auto rounded-2xl border border-border bg-muted/30 p-3 text-xs leading-relaxed">
            {manifest}
          </pre>
        </div>

        <ol className="space-y-1.5 text-sm">
          {[
            'Click Open Slack, choose "From a manifest", paste the JSON, confirm.',
            'On the next screen, click Install to Workspace and approve.',
            'Copy the Bot User OAuth Token (xoxb-…) and Signing Secret.',
          ].map((line, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                {i + 1}
              </span>
              <span className="text-muted-foreground">{line}</span>
            </li>
          ))}
        </ol>

        <div className="flex justify-end">
          <Button size="sm" onClick={() => setStep(2)}>
            Next: paste tokens
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Step 2 of 2 — paste the two values. They&apos;re stored in{' '}
        <code className="font-mono text-xs">project_secrets</code> alongside any
        other secrets the project uses.
      </p>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="bot-token">Bot User OAuth Token</Label>
          <Input
            id="bot-token"
            placeholder="xoxb-…"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Slack → Your App → OAuth &amp; Permissions → Bot User OAuth Token.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signing-secret">Signing Secret</Label>
          <Input
            id="signing-secret"
            placeholder="••••••••"
            type="password"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Slack → Your App → Basic Information → App Credentials → Signing
            Secret.
          </p>
        </div>
      </div>

      {error ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
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
          {connect.isPending ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : null}
          Connect Slack
        </Button>
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
