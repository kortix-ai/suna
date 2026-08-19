'use client';

/**
 * "Use your own Microsoft Teams app" — the self-hosted / custom-bot install
 * path for the Teams channel, rendered under the channel rows in
 * `channels-view.tsx`.
 *
 * ## Scope of this pass: chrome, not flow
 *
 * This file was aligned with the rebuilt Slack surface so it stops looking
 * foreign directly beneath it. What changed is presentation only:
 *
 * - `SectionCard` (a banned legacy wrapper) → the sanctioned
 *   `bg-popover rounded-md border` panel.
 * - A hand-rolled `<button>` + rotating caret → the shared `Disclosure`.
 * - `rounded-2xl` on the panel, the manifest `<pre>`, and the error box →
 *   `rounded-md` / `rounded-sm`, matching the app radius scale.
 * - A hand-rolled tinted `<p>` for errors → `InfoBanner tone="destructive"`.
 * - A raw `<input type="checkbox">` → `Switch`.
 * - A local copy button that hard-swapped `{copied ? <Check/> : <Copy/>}`
 *   (which blinks) → the shared `ManifestCopyBlock`, so Slack and Teams now
 *   have one copy implementation instead of two. That block also absorbed the
 *   uppercase "App manifest" caption and the separate max-h-64 `<pre>` — three
 *   elements describing one object, collapsed into one.
 * - `h-3.5 w-3.5` → `size-3.5`; `<a><Button/></a>` → `Button asChild`.
 *
 * **The install FLOW is deliberately unchanged.** Slack's equivalent became a
 * three-step wizard (`component/slack-byo-wizard.tsx`), and Teams should get
 * the same treatment — but its inputs are a different shape (tenant id, plus
 * an app id and client secret only in BYO mode, plus an app package that has
 * to be built from the manifest with icon files Slack does not require). That
 * is its own change against a tenant that can actually be exercised, not a
 * side effect of a Slack redesign. Same fields, same `useConnectTeams` call,
 * same `canSubmit` rule as before this edit.
 */

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Switch } from '@/components/ui/switch';
import { ManifestCopyBlock } from '@/features/workspace/customize/sections/component/manifest-copy-block';
import {
  useConnectTeams,
  useTeamsManifest,
  useTeamsMode,
  type TeamsMode,
} from '@/hooks/channels/use-teams-installations';
import { ArrowSquareOutIcon as ExternalLinkIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

/** One instruction per line, in the order a user performs them. */
const TEAMS_MANIFEST_STEPS = [
  'Grant admin consent so the Kortix bot can run in your tenant.',
  'In Teams Admin Center (or Teams → Apps → Manage your apps → Upload), upload an app package built from this manifest, plus color.png and outline.png icons.',
  'Add the app to a chat or channel, then paste your tenant ID below to bind it to this project.',
];

export function TeamsChannelPanel({ projectId }: { projectId: string }) {
  const { data: mode, isLoading } = useTeamsMode(projectId);

  if (isLoading || !mode?.enabled) return null;

  return (
    <Disclosure variant="outline" className="overflow-hidden">
      <DisclosureTrigger variant="outline">
        <Button
          variant="ghost-input"
          className="flex h-fit w-full items-center justify-between rounded-none py-2.5"
        >
          <div className="min-w-0 text-left">
            <p className="text-sm font-medium">Use your own Microsoft Teams app</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              For self-hosted setups, or to sideload the app into your tenant manually.
            </p>
          </div>
        </Button>
      </DisclosureTrigger>
      <DisclosureContent
        variant="outline"
        contentClassName="border-border bg-popover border-t px-4 py-5"
      >
        <InstallFlow projectId={projectId} mode={mode} />
      </DisclosureContent>
    </Disclosure>
  );
}

function InstallFlow({ projectId, mode }: { projectId: string; mode: TeamsMode | undefined }) {
  const managedAvailable = Boolean(mode?.available && !mode.byo);
  const [tenantId, setTenantId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [byo, setByo] = useState(!managedAvailable);
  const [appId, setAppId] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectTeams();
  const manifest = useTeamsManifest(projectId);
  const manifestText = manifest.data ?? '';

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
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-foreground text-sm font-medium">Add Kortix to Microsoft Teams</h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Install the Kortix app into your Teams tenant, then bind this project to that tenant.
        </p>
      </div>

      {managedAvailable && !byo ? (
        <>
          {/* One block carries the label, the copy control, and the file
              itself. It replaced an uppercase "App manifest" caption + a copy
              button + a separate max-h-64 <pre> below — three elements
              describing one object, with the tallest of them dominating the
              panel. */}
          <div className="space-y-2">
            <ManifestCopyBlock
              text={manifestText}
              filename="teams-app-manifest.json"
              loading={manifest.isLoading}
              error={
                manifest.error instanceof Error
                  ? `Failed to load manifest: ${manifest.error.message}`
                  : null
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" asChild>
                <Link href={mode?.adminConsentUrl ?? '#'} target="_blank" rel="noopener noreferrer">
                  Grant admin consent
                  <ExternalLinkIcon className="size-3.5 shrink-0" />
                </Link>
              </Button>
            </div>
          </div>

          <ol className="list-decimal space-y-1.5 pl-5">
            {TEAMS_MANIFEST_STEPS.map((line) => (
              <li key={line} className="text-muted-foreground text-sm leading-relaxed">
                {line}
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {managedAvailable ? (
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="teams-byo" className="text-muted-foreground text-sm font-normal">
            Use your own Azure bot instead of the managed Kortix bot
          </Label>
          <Switch id="teams-byo" checked={byo} onCheckedChange={setByo} />
        </div>
      ) : (
        <InfoBanner tone="neutral">
          No managed Kortix Teams bot is configured on this server. Register a multi-tenant Azure
          Bot and connect its credentials below; after connecting, point its messaging endpoint at
          this project&apos;s Teams webhook.
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
        <InfoBanner tone="destructive" title="Could not connect">
          {error}
        </InfoBanner>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={connect.isPending || !canSubmit}>
          {connect.isPending ? <Loading className="mr-2 size-3.5 shrink-0" /> : null}
          Connect Teams
        </Button>
      </div>
    </div>
  );
}
