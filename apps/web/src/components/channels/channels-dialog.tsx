'use client';

import { useEffect, useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { backendApi } from '@/lib/api-client';
import {
  useSlackInstall,
  useConnectSlack,
  useDisconnectSlack,
  type SlackInstallation,
} from '@/hooks/channels/use-channels-installations';

interface ChannelsHealth {
  mode: 'off' | 'single' | 'multi' | 'both';
  single_ready: boolean;
  multi_ready: boolean;
  errors: string[];
}

interface ChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
}

export function ChannelsDialog({ open, onOpenChange, projectId }: ChannelsDialogProps) {
  const [health, setHealth] = useState<ChannelsHealth | null>(null);
  const [manifest, setManifest] = useState<string | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingMeta(true);
    setHealth(null);
    setManifest(null);
    (async () => {
      const [healthRes, manifestRes] = await Promise.all([
        backendApi.get<ChannelsHealth>('/webhooks/chat/health', { showErrors: false }),
        backendApi.get<unknown>('/webhooks/chat/slack/manifest', { showErrors: false }),
      ]);
      if (cancelled) return;
      if (healthRes.success && healthRes.data) setHealth(healthRes.data);
      if (manifestRes.success && manifestRes.data) {
        setManifest(JSON.stringify(manifestRes.data, null, 2));
      }
      setLoadingMeta(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const loading = loadingMeta || loadingInstall;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Slack className="h-4 w-4" />
            Channels
          </DialogTitle>
          <DialogDescription>
            Connect Slack so the agent can run from a workspace channel — per project.
          </DialogDescription>
        </DialogHeader>

        {!projectId ? (
          <div className="rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Open a project to manage its Slack connection. Each project has its own Slack install stored in
            that project's secrets.
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : install ? (
          <Connected projectId={projectId} installation={install} />
        ) : !health || health.mode === 'off' ? (
          <NotConfigured errors={health?.errors ?? []} />
        ) : (
          <SelfInstall projectId={projectId} manifest={manifest} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NotConfigured({ errors }: { errors: string[] }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm">
      <p className="font-medium text-foreground">Channels aren't configured on this server.</p>
      <p className="mt-1 text-muted-foreground">
        Restart the API with <code className="font-mono text-xs">KORTIX_CHANNELS_MODE=auto</code> (the
        default) and try again. No other env vars are needed for self-install — each project pastes its own
        Slack tokens through this dialog.
      </p>
      {errors.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
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
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-sm">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15">
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            Connected to {installation.workspaceName ?? installation.workspaceId}
          </p>
          <p className="text-xs text-muted-foreground">
            Bot user <code className="font-mono">{installation.botUserId ?? '—'}</code> · team{' '}
            <code className="font-mono">{installation.workspaceId}</code>
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card px-4 py-3 text-sm">
        <p className="font-medium text-foreground">Next: enable for this project</p>
        <p className="mt-1 text-muted-foreground">
          Add a <code className="font-mono text-xs">[[channels]]</code> entry with{' '}
          <code className="font-mono text-xs">platform = "slack"</code> to this project's{' '}
          <code className="font-mono text-xs">kortix.toml</code>, invite the bot to a channel, and{' '}
          <code className="font-mono text-xs">@kortix</code> — replies stream right here.
        </p>
      </div>

      <div className="flex items-center justify-end pt-1">
        {confirming ? (
          <div className="flex items-center gap-2">
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

function SelfInstall({ projectId, manifest }: { projectId: string; manifest: string | null }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectSlack();

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
        <p className="text-sm text-muted-foreground">
          Step 1 of 2 — paste the manifest into Slack to create the app with all URLs, scopes and events
          pre-baked.
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
                disabled={!manifest}
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
                  Open Slack
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </a>
            </div>
          </div>
          <pre
            className={cn(
              'max-h-64 overflow-auto rounded-2xl border border-border bg-muted/30 p-3 text-xs leading-relaxed',
            )}
          >
            {manifest ?? '…'}
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
          <Button onClick={() => setStep(2)}>Next — paste tokens</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Step 2 of 2 — paste the two values. Stored encrypted in this project's secrets manager (
        <code className="font-mono text-xs">project_secrets</code>) alongside any other secrets the project
        uses.
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
            Slack → your app → OAuth & Permissions → Bot User OAuth Token.
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
            Slack → your app → Basic Information → App Credentials → Signing Secret.
          </p>
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
          {connect.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Connect Slack
        </Button>
      </div>
    </div>
  );
}
