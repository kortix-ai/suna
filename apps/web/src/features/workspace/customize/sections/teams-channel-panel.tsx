'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import {
  useConnectTeams,
  useTeamsManifest,
  useTeamsMode,
  type TeamsMode,
} from '@/hooks/channels/use-teams-installations';
import { Check, ChevronDown, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';

export function TeamsChannelPanel({ projectId }: { projectId: string }) {
  const { data: mode, isLoading } = useTeamsMode(projectId);
  const [open, setOpen] = useState(false);

  if (isLoading || !mode?.enabled) return null;

  return (
    <div className="border-border bg-muted/20 overflow-hidden rounded-2xl border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted/30 flex w-full items-center justify-between gap-3 p-4 text-left transition-colors"
      >
        <div>
          <div className="text-foreground text-sm font-medium">Bring your own Microsoft Teams bot</div>
          <div className="text-muted-foreground text-xs">
            For self-hosted setups, or to sideload the app manually.
          </div>
        </div>
        <ChevronDown
          className={`text-muted-foreground size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <div className="border-border/60 border-t p-4">
          <InstallFlow projectId={projectId} mode={mode} />
        </div>
      ) : null}
    </div>
  );
}

function InstallFlow({ projectId, mode }: { projectId: string; mode: TeamsMode | undefined }) {
  const managedAvailable = Boolean(mode?.available && !mode.byo);
  const [copied, setCopied] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [byo, setByo] = useState(!managedAvailable);
  const [appId, setAppId] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectTeams();
  const manifest = useTeamsManifest(projectId);
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
        tenant_id: tenantId.trim(),
        team_name: teamName.trim() || undefined,
        ...(byo ? { app_id: appId.trim(), app_password: appPassword.trim() } : {}),
      },
      { onError: (e) => setError((e as Error).message) },
    );
  };

  const canSubmit = tenantId.trim() && (!byo || (appId.trim() && appPassword.trim()));

  return (
    <SectionCard
      title="Add Kortix to Microsoft Teams"
      description="Install the Kortix app into your Teams tenant, then bind this project to that tenant."
    >
      <div className="space-y-5">
        {managedAvailable && !byo ? (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  App manifest
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={copyManifest} disabled={!manifestText} className="h-7 gap-1.5">
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                  <a href={mode?.adminConsentUrl ?? '#'} target="_blank" rel="noopener noreferrer" className="inline-flex">
                    <Button variant="outline" size="sm" className="h-7 gap-1.5">
                      Grant admin consent
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
                'Grant admin consent so the Kortix bot can run in your tenant.',
                'In Teams Admin Center (or Teams → Apps → Manage your apps → Upload), upload an app package built from the manifest above (plus color.png + outline.png icons).',
                'Add the app to a chat or channel, then paste your Azure AD tenant ID below to bind it to this project.',
              ].map((line, i) => (
                <li key={i} className="flex gap-3">
                  <span className="bg-muted text-muted-foreground mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {i + 1}
                  </span>
                  <span className="text-muted-foreground">{line}</span>
                </li>
              ))}
            </ol>
          </>
        ) : null}

        {managedAvailable ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={byo} onChange={(e) => setByo(e.target.checked)} />
            <span className="text-muted-foreground">Bring your own Azure bot instead of the managed Kortix bot</span>
          </label>
        ) : (
          <InfoBanner tone="neutral">
            No managed Kortix Teams bot is configured on this server. Register a multi-tenant Azure Bot and connect its
            credentials below; after connecting, point its messaging endpoint at this project&apos;s Teams webhook.
          </InfoBanner>
        )}

        {byo ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="teams-app-id">Bot app (client) ID</Label>
              <Input
                id="teams-app-id"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="teams-app-password">Bot client secret</Label>
              <Input
                id="teams-app-password"
                type="password"
                placeholder="Client secret value"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="teams-tenant-id">Azure AD tenant ID</Label>
            <Input
              id="teams-tenant-id"
              placeholder="00000000-0000-0000-0000-000000000000 or contoso.onmicrosoft.com"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              Found in Azure Portal → Microsoft Entra ID → Overview → Tenant ID.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="teams-team-name">Team name (optional)</Label>
            <Input
              id="teams-team-name"
              placeholder="Acme Corp"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        {error ? (
          <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-2xl border px-3 py-2 text-xs">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={connect.isPending || !canSubmit}>
            {connect.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Connect Teams
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
