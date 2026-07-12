'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { cn } from '@/lib/utils';
import type { EmailSenderPolicy } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Loader2, Mail, MessageSquare, Video } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function ChannelsTab({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-4">
      <SlackCard projectId={projectId} />
      <EmailCard projectId={projectId} />
      <MeetCard projectId={projectId} />
    </div>
  );
}

function FieldRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('truncate', mono && 'font-mono text-xs leading-5')}>
        {value || 'not set'}
      </span>
    </div>
  );
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function DisconnectDialog({
  channel,
  pending,
  onConfirm,
}: {
  channel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          className="text-destructive hover:text-destructive"
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Disconnect
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Disconnect {channel}?</DialogTitle>
          <DialogDescription>
            The agent stops receiving messages from this channel. You can reconnect later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SlackCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const installKey = ['channels', projectId, 'slack'] as const;

  const installation = useQuery({
    queryKey: installKey,
    queryFn: () => kortix.project(projectId).channels.slack.installation(),
    retry: false,
  });
  const mode = useQuery({
    queryKey: ['channels', projectId, 'slack', 'mode'],
    queryFn: () => kortix.project(projectId).channels.slack.mode(),
    retry: false,
  });

  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');

  const connect = useMutation({
    mutationFn: () =>
      kortix.project(projectId).channels.slack.connect({
        bot_token: botToken.trim(),
        signing_secret: signingSecret.trim(),
      }),
    onSuccess: () => {
      setBotToken('');
      setSigningSecret('');
      qc.invalidateQueries({ queryKey: installKey });
      toast.success('Slack connected');
    },
    onError: () => toast.error('Could not connect Slack'),
  });

  const disconnect = useMutation({
    mutationFn: () => kortix.project(projectId).channels.slack.disconnect(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: installKey });
      toast.success('Slack disconnected');
    },
    onError: () => toast.error('Could not disconnect Slack'),
  });

  const installed = installation.data ?? null;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <MessageSquare className="size-4 text-muted-foreground" /> Slack
            {installed && <Badge>connected</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {installed
              ? 'The agent listens and replies in your Slack workspace.'
              : 'Connect a Slack app so the agent can listen and reply in your workspace.'}
          </p>
        </div>
        {installed && (
          <DisconnectDialog
            channel="Slack"
            pending={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        )}
      </div>

      {installation.isLoading && <Skeleton className="mt-4 h-16 w-full" />}

      {installation.isSuccess && installed && (
        <div className="mt-4 space-y-2">
          <FieldRow
            label="Workspace"
            value={installed.workspaceName ?? installed.workspaceId}
            mono={!installed.workspaceName}
          />
          <FieldRow label="Workspace ID" value={installed.workspaceId} />
          <FieldRow label="Bot user" value={installed.botUserId} />
          <FieldRow
            label="Installed"
            value={new Date(installed.installedAt).toLocaleDateString()}
            mono={false}
          />
          {mode.isSuccess && (
            <FieldRow
              label="Install mode"
              value={mode.data.oauth_available ? 'OAuth' : 'Manual (manifest)'}
              mono={false}
            />
          )}
        </div>
      )}

      {installation.isSuccess && !installed && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SlackManifestDialog projectId={projectId} />
            {mode.data?.oauth_available && mode.data.install_url && (
              <Button variant="outline" size="sm" asChild>
                <a href={mode.data.install_url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Add to Slack
                </a>
              </Button>
            )}
          </div>
          <Separator />
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (botToken.trim() && signingSecret.trim()) connect.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="slack-bot-token">Bot token</Label>
              <Input
                id="slack-bot-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-..."
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="slack-signing-secret">Signing secret</Label>
              <Input
                id="slack-signing-secret"
                type="password"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="From your Slack app settings"
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <div className="sm:col-span-2 flex justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={!botToken.trim() || !signingSecret.trim() || connect.isPending}
              >
                {connect.isPending && <Loader2 className="size-4 animate-spin" />}
                Connect Slack
              </Button>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
}

function SlackManifestDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const manifest = useQuery({
    queryKey: ['channels', projectId, 'slack', 'manifest'],
    queryFn: () => kortix.project(projectId).channels.slack.manifest(),
    enabled: open,
    retry: false,
  });

  const json = manifest.data ? JSON.stringify(manifest.data, null, 2) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast.success('Manifest copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          View app manifest
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Slack app manifest</DialogTitle>
          <DialogDescription>
            Create a Slack app from this manifest at api.slack.com, then paste its bot token and
            signing secret into the connect form.
          </DialogDescription>
        </DialogHeader>
        {manifest.isLoading && <Skeleton className="h-40 w-full" />}
        {manifest.isError && (
          <p className="text-sm text-destructive">Could not load the manifest.</p>
        )}
        {manifest.isSuccess && (
          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-1.5 right-1.5 size-8 text-muted-foreground"
              aria-label="Copy manifest"
              onClick={copy}
            >
              <Copy className="size-4" />
            </Button>
            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-secondary/50 p-3 font-mono text-xs">
              {json}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmailCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const installKey = ['channels', projectId, 'email'] as const;

  const installation = useQuery({
    queryKey: installKey,
    queryFn: () => kortix.project(projectId).channels.email.installation(),
    retry: false,
  });
  const mode = useQuery({
    queryKey: ['channels', projectId, 'email', 'mode'],
    queryFn: () => kortix.project(projectId).channels.email.mode(),
    retry: false,
  });

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [domain, setDomain] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [inboxId, setInboxId] = useState('');
  const [address, setAddress] = useState('');

  const connect = useMutation({
    mutationFn: () =>
      kortix.project(projectId).channels.email.connect({
        display_name: displayName.trim() || undefined,
        username: username.trim() || undefined,
        domain: domain.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        inbox_id: inboxId.trim() || undefined,
        email: address.trim() || undefined,
      }),
    onSuccess: () => {
      setDisplayName('');
      setUsername('');
      setDomain('');
      setApiKey('');
      setInboxId('');
      setAddress('');
      qc.invalidateQueries({ queryKey: installKey });
      toast.success('Email connected');
    },
    onError: () => toast.error('Could not connect email'),
  });

  const disconnect = useMutation({
    mutationFn: () =>
      kortix.project(projectId).channels.email.disconnect(installation.data?.profileSlug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: installKey });
      toast.success('Email disconnected');
    },
    onError: () => toast.error('Could not disconnect email'),
  });

  const updatePolicy = useMutation({
    mutationFn: (policy: EmailSenderPolicy) =>
      kortix.project(projectId).channels.email.updatePolicy(installation.data?.profileSlug, policy),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: installKey });
      toast.success('Sender policy saved');
    },
    onError: () => toast.error('Could not save sender policy'),
  });

  const installed = installation.data ?? null;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Mail className="size-4 text-muted-foreground" /> Email
            {installed && <Badge>connected</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {installed
              ? 'The agent reads and replies to mail in its own inbox.'
              : mode.data?.managed_available
                ? 'Give the agent an inbox. Leave everything blank for a managed inbox, or bring your own AgentMail credentials.'
                : 'Give the agent an inbox by connecting your AgentMail credentials.'}
          </p>
        </div>
        {installed && (
          <DisconnectDialog
            channel="email"
            pending={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        )}
      </div>

      {installation.isLoading && <Skeleton className="mt-4 h-16 w-full" />}

      {installation.isSuccess && installed && (
        <div className="mt-4 space-y-3">
          <div className="space-y-2">
            <FieldRow label="Address" value={installed.email} />
            <FieldRow label="Display name" value={installed.displayName} mono={false} />
            <FieldRow label="Inbox ID" value={installed.inboxId} />
            <FieldRow label="Profile" value={installed.profileSlug} />
            <FieldRow
              label="Installed"
              value={new Date(installed.installedAt).toLocaleDateString()}
              mono={false}
            />
            {mode.isSuccess && (
              <FieldRow label="Provider" value={mode.data.provider} mono={false} />
            )}
          </div>
          <Separator />
          <EmailPolicyForm
            key={installed.inboxId}
            policy={installed.senderPolicy}
            pending={updatePolicy.isPending}
            onSave={(policy) => updatePolicy.mutate(policy)}
          />
        </div>
      )}

      {installation.isSuccess && !installed && (
        <form
          className="mt-4 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="em-display-name">Display name</Label>
            <Input
              id="em-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Lumen Agent"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="em-username">Username</Label>
            <Input
              id="em-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="lumen"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="em-domain">Domain</Label>
            <Input
              id="em-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="agentmail.to"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="em-api-key">AgentMail API key</Label>
            <Input
              id="em-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Optional with a managed inbox"
              autoComplete="off"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="em-inbox-id">Existing inbox ID</Label>
            <Input
              id="em-inbox-id"
              value={inboxId}
              onChange={(e) => setInboxId(e.target.value)}
              placeholder="Optional"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="em-address">Existing address</Label>
            <Input
              id="em-address"
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Optional"
              className="font-mono"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" size="sm" disabled={connect.isPending}>
              {connect.isPending && <Loader2 className="size-4 animate-spin" />}
              Connect email
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function EmailPolicyForm({
  policy,
  pending,
  onSave,
}: {
  policy: EmailSenderPolicy;
  pending: boolean;
  onSave: (policy: EmailSenderPolicy) => void;
}) {
  const [policyMode, setPolicyMode] = useState<EmailSenderPolicy['mode']>(policy.mode);
  const [emails, setEmails] = useState(policy.allowedEmails.join(', '));
  const [domains, setDomains] = useState(policy.allowedDomains.join(', '));
  const [regex, setRegex] = useState(policy.allowedRegex ?? '');

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          mode: policyMode,
          allowedEmails: splitList(emails),
          allowedDomains: splitList(domains),
          allowedRegex: regex.trim() || null,
        });
      }}
    >
      <div>
        <div className="text-sm font-medium">Sender policy</div>
        <p className="text-xs text-muted-foreground">Who is allowed to email the agent.</p>
      </div>
      <div className="space-y-1.5">
        <Label>Mode</Label>
        <Select
          value={policyMode}
          onValueChange={(v) => setPolicyMode(v as EmailSenderPolicy['mode'])}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow_all">Allow all senders</SelectItem>
            <SelectItem value="restricted">Restricted</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {policyMode === 'restricted' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="ep-emails">Allowed emails (comma separated)</Label>
            <Input
              id="ep-emails"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="alice@acme.com, bob@acme.com"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ep-domains">Allowed domains (comma separated)</Label>
            <Input
              id="ep-domains"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="acme.com"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ep-regex">Allowed regex (optional)</Label>
            <Input
              id="ep-regex"
              value={regex}
              onChange={(e) => setRegex(e.target.value)}
              placeholder="^.+@acme\.(com|io)$"
              className="font-mono"
            />
          </div>
        </>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          Save policy
        </Button>
      </div>
    </form>
  );
}

function MeetCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['channels', projectId, 'meet'] as const;

  const voices = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(projectId).channels.meet.voices(),
    retry: false,
  });

  const setVoice = useMutation({
    mutationFn: (voice: string) => kortix.project(projectId).channels.meet.setVoice(voice),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      toast.success('Voice updated');
    },
    onError: () => toast.error('Could not update voice'),
  });

  const setBotName = useMutation({
    mutationFn: (name: string) => kortix.project(projectId).channels.meet.setBotName(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      toast.success('Bot name saved');
    },
    onError: () => toast.error('Could not save bot name'),
  });

  const data = voices.data ?? null;

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Video className="size-4 text-muted-foreground" /> Meet
        {data && !data.speak_enabled && <Badge variant="secondary">speaking off</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        The voice and name the agent uses when it joins meetings.
      </p>

      {voices.isLoading && <Skeleton className="mt-4 h-16 w-full" />}

      {voices.isSuccess && !data && (
        <p className="mt-4 text-sm text-muted-foreground">Not available on this deployment.</p>
      )}

      {data && (
        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <Label>Voice</Label>
            <Select
              value={data.selected}
              onValueChange={(v) => setVoice.mutate(v)}
              disabled={setVoice.isPending}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a voice" />
              </SelectTrigger>
              <SelectContent>
                {data.voices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id}>
                    <span>{voice.name}</span>
                    <span className="text-xs text-muted-foreground">{voice.desc}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <MeetBotNameForm
            key={data.bot_name}
            initial={data.bot_name}
            placeholder={data.default_bot_name}
            pending={setBotName.isPending}
            onSave={(name) => setBotName.mutate(name)}
          />
        </div>
      )}
    </Card>
  );
}

function MeetBotNameForm({
  initial,
  placeholder,
  pending,
  onSave,
}: {
  initial: string;
  placeholder: string;
  pending: boolean;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);

  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
      }}
    >
      <Label htmlFor="meet-bot-name">Bot name</Label>
      <div className="flex gap-2">
        <Input
          id="meet-bot-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={pending || !name.trim() || name.trim() === initial}
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}
