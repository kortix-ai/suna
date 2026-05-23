'use client';

import { use, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFrontendClient } from '@pipedream/sdk/browser';
import {
  Boxes,
  Globe,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/lib/toast';
import {
  createConnector,
  deleteConnector,
  listConnectors,
  listPipedreamApps,
  listProjectAccess,
  pipedreamConnect,
  pipedreamFinalize,
  setConnectorCredential,
  setConnectorSharing,
  syncConnectors,
  type AdminConnector,
  type ConnectorAction,
  type ConnectorDraftInput,
  type ConnectorSharing,
} from '@/lib/projects-client';

const PROVIDER_ICON: Record<AdminConnector['provider'], LucideIcon> = {
  pipedream: Zap,
  mcp: Boxes,
  openapi: Globe,
  graphql: Globe,
  http: Globe,
};

const RISK_VARIANT: Record<ConnectorAction['risk'], 'outline' | 'secondary' | 'destructive'> = {
  read: 'outline',
  write: 'secondary',
  destructive: 'destructive',
};

export default function ProjectConnectorsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params);
  return <ConnectorsView projectId={projectId} />;
}

/** Reusable view — rendered both at /connectors and inside CustomizeView. */
export function ConnectorsView({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Plug className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Connectors</h1>
      </div>
      <ConnectorsBody projectId={projectId} />
    </div>
  );
}

function ConnectorsBody({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    staleTime: 10_000,
  });
  const isForbidden = query.isError && /403|forbidden/i.test((query.error as Error)?.message ?? '');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
        <header className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Connectors</h2>
          <p className="text-xs text-muted-foreground">
            Integrations the agent reaches through the Executor. Stored in{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">kortix.toml</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">[[connectors]]</code>;
            credentials and who-can-use-them are managed here. Calls run server-side — no secrets
            ever touch the sandbox.
          </p>
        </header>

        {query.isLoading ? (
          <ConnectorsSkeleton />
        ) : isForbidden ? (
          <InfoBanner tone="warning" icon={ShieldAlert} title="Admin access required">
            Only project managers can manage connectors.
          </InfoBanner>
        ) : query.isError ? (
          <InfoBanner
            tone="destructive"
            title="Failed to load connectors"
            action={
              <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                Retry
              </Button>
            }
          >
            {(query.error as Error)?.message ?? 'Unknown error'}
          </InfoBanner>
        ) : (
          <ConnectorsCard projectId={projectId} connectors={query.data?.connectors ?? []} />
        )}
      </div>
    </div>
  );
}

function ConnectorsCard({ projectId, connectors }: { projectId: string; connectors: AdminConnector[] }) {
  const queryClient = useQueryClient();
  const queryKey = ['project-connectors', projectId];
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const [toolsFor, setToolsFor] = useState<AdminConnector | null>(null);
  const [shareFor, setShareFor] = useState<AdminConnector | null>(null);
  const [credFor, setCredFor] = useState<AdminConnector | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const sync = useMutation({
    mutationFn: () => syncConnectors(projectId),
    onSuccess: (res) => {
      invalidate();
      if (res.errors.length) {
        toast.warning(`Synced ${res.synced}, ${res.errors.length} with issues`);
      } else {
        toast.success(`Synced ${res.synced} connector(s)`);
      }
    },
    onError: (err: Error) => toast.error(err.message || 'Sync failed'),
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Connectors"
        count={connectors.length || undefined}
        description="Stored in kortix.toml. Add a connector or browse the app catalogue."
        flush
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add connector
            </Button>
          </div>
        }
      >
        {connectors.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="No connectors yet"
            description="Add a connector or pick an app to connect."
            action={<Button size="sm" onClick={() => setAddOpen(true)} className="gap-1.5"><Plus className="h-3.5 w-3.5" />Add connector</Button>}
          />
        ) : (
          <List>
            {connectors.map((conn) => (
              <ConnectorRow
                key={conn.slug}
                projectId={projectId}
                conn={conn}
                onViewTools={() => setToolsFor(conn)}
                onShare={() => setShareFor(conn)}
                onSetCredential={() => setCredFor(conn)}
                onChanged={invalidate}
                onConnected={() => { invalidate(); setShareFor({ ...conn, secretSet: true }); }}
              />
            ))}
          </List>
        )}
      </SectionCard>

      <ConnectorToolsDialog connector={toolsFor} open={!!toolsFor} onOpenChange={(o) => !o && setToolsFor(null)} />
      <ConnectorSharingDialog projectId={projectId} connector={shareFor} open={!!shareFor} onOpenChange={(o) => !o && setShareFor(null)} onSaved={invalidate} />
      <SetCredentialDialog projectId={projectId} connector={credFor} open={!!credFor} onOpenChange={(o) => !o && setCredFor(null)} onSaved={() => { const c = credFor; invalidate(); if (c) setShareFor(c); }} />
      <AddConnectorDialog projectId={projectId} open={addOpen} onOpenChange={setAddOpen} onAdded={invalidate} />
    </div>
  );
}

function ConnectorRow({
  projectId,
  conn,
  onViewTools,
  onShare,
  onSetCredential,
  onChanged,
  onConnected,
}: {
  projectId: string;
  conn: AdminConnector;
  onViewTools: () => void;
  onShare: () => void;
  onSetCredential: () => void;
  onChanged: () => void;
  onConnected: () => void;
}) {
  const Icon = PROVIDER_ICON[conn.provider] ?? Plug;
  const isPipedream = conn.provider === 'pipedream';
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Pipedream 1-click: in-page overlay via the SDK, then finalize the binding.
  const connect = useMutation({
    mutationFn: async () => {
      const { token, app } = await pipedreamConnect(projectId, conn.slug);
      if (!token || !app) throw new Error('App connect is not configured');
      // The SDK renders an in-page overlay (no new tab). It needs a token
      // callback + external user id; we feed it the token our backend minted.
      const pd = createFrontendClient({
        externalUserId: `${projectId}:${conn.slug}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tokenCallback: async () => ({ token, connect_link_url: undefined, expires_at: '' }) as any,
      });
      await new Promise<void>((resolve, reject) => {
        pd.connectAccount({
          app,
          token,
          onSuccess: () => resolve(),
          onError: (err: unknown) => reject(new Error((err as Error)?.message || 'Connection cancelled')),
        });
      });
      return pipedreamFinalize(projectId, conn.slug);
    },
    // After connecting (credential now exists) prompt the scoping question.
    onSuccess: () => { toast.success('Connected — now choose who can use it'); onConnected(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteConnector(projectId, conn.slug),
    onSuccess: () => { toast.success(`Removed ${conn.slug}`); onChanged(); },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove'),
  });

  return (
    <ListRow
      leading={<EntityAvatar icon={Icon} size="sm" />}
      title={<span className="truncate text-sm font-medium text-foreground">{conn.slug}</span>}
      badges={
        <>
          <Badge variant="outline" size="sm">{providerLabel(conn.provider)}</Badge>
          {conn.credentialMode === 'per_user' && <Badge variant="outline" size="sm">Per-user</Badge>}
          {conn.authSecret && !conn.secretSet && <Badge variant="warning" size="sm">Needs auth</Badge>}
          {conn.status === 'error' && <Badge variant="destructive" size="sm">Error</Badge>}
          {conn.status === 'disabled' && <Badge variant="outline" size="sm">Disabled</Badge>}
          {conn.sharing && <Badge variant="secondary" size="sm">{sharingLabel(conn.sharing)}</Badge>}
        </>
      }
      subtitle={
        confirmDelete ? (
          <span className="text-xs text-muted-foreground">Remove this connector from kortix.toml?</span>
        ) : (
          <InlineMeta>
            {`${conn.actions.length} ${conn.actions.length === 1 ? 'tool' : 'tools'}`}
            {conn.authSecret ? (conn.secretSet ? 'credential set' : 'credential not set') : 'no auth'}
          </InlineMeta>
        )
      }
      trailing={
        confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Remove'}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {isPipedream && !conn.secretSet && (
              <Button size="sm" variant="default" className="h-7 px-2 text-xs" onClick={() => connect.mutate()} disabled={connect.isPending}>
                {connect.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Connect'}
              </Button>
            )}
            {!isPipedream && conn.authSecret && !conn.secretSet && (
              <Button size="sm" variant="default" className="h-7 px-2 text-xs" onClick={onSetCredential}>Set credential</Button>
            )}
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onViewTools} aria-label="View tools"><Wrench className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onShare} aria-label="Manage sharing"><Share2 className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        )
      }
    />
  );
}

function sharingLabel(s: ConnectorSharing): string {
  if (s.mode === 'project') return 'Project-wide';
  if (s.mode === 'private') return 'Only me';
  return 'Select members';
}

/** Forward-facing provider label — "App" for the 1-click (Pipedream) connectors. */
function providerLabel(p: AdminConnector['provider']): string {
  return p === 'pipedream' ? 'App' : p.toUpperCase();
}

// ─── Setup fields (asked at Add): credential mode + access ───────────────────

interface ConnectorSetup {
  credential: 'shared' | 'per_user';
  access: 'project' | 'private' | 'members';
  memberIds: string[];
}

function setupToSharing(s: ConnectorSetup): ConnectorSharing {
  if (s.access === 'project') return { mode: 'project' };
  if (s.access === 'private') return { mode: 'private', ownerId: '' };
  return { mode: 'members', memberIds: s.memberIds };
}

function ConnectorSetupFields({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: ConnectorSetup;
  onChange: (s: ConnectorSetup) => void;
}) {
  const members = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    enabled: value.access === 'members',
    staleTime: 30_000,
  });
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Credential</Label>
        <RadioGroup value={value.credential} onValueChange={(v) => onChange({ ...value, credential: v as ConnectorSetup['credential'] })} className="space-y-2">
          <ShareOption value="shared" label="Shared" desc="One connection for the whole project" current={value.credential} />
          <ShareOption value="per_user" label="Each member connects their own" desc="Every member links their own account (BYO)" current={value.credential} />
        </RadioGroup>
      </div>
      <div className="space-y-2">
        <Label>Who can use it</Label>
        <RadioGroup value={value.access} onValueChange={(v) => onChange({ ...value, access: v as ConnectorSetup['access'] })} className="space-y-2">
          <ShareOption value="project" label="Project-wide" desc="Every member of this project" current={value.access} />
          <ShareOption value="private" label="Only me" desc="Just you" current={value.access} />
          <ShareOption value="members" label="Select members" desc="A chosen list of members" current={value.access} />
        </RadioGroup>
        {value.access === 'members' && (
          <div className="space-y-2 rounded-2xl border border-border/60 p-3">
            {members.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              (members.data?.members ?? []).map((m) => (
                <label key={m.user_id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={value.memberIds.includes(m.user_id)}
                    onCheckedChange={(c) =>
                      onChange({ ...value, memberIds: c ? [...value.memberIds, m.user_id] : value.memberIds.filter((id) => id !== m.user_id) })
                    }
                  />
                  <span className="truncate">{m.email ?? m.user_id}</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Add connector — Pipedream catalogue + custom ───────────────────────────

function AddConnectorDialog({
  projectId,
  open,
  onOpenChange,
  onAdded,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>Add a connector</DialogTitle>
          <DialogDescription>One-click connect a popular app, or add a custom source. Saved to kortix.toml.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="apps">
          <div className="px-6 pt-4">
            <TabsList>
              <TabsTrigger value="apps">Easy connect</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="apps" className="m-0">
            <AppCatalogue projectId={projectId} onAdded={() => { onAdded(); onOpenChange(false); }} />
          </TabsContent>
          <TabsContent value="custom" className="m-0">
            <CustomConnectorForm projectId={projectId} onAdded={() => { onAdded(); onOpenChange(false); }} onCancel={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Easy-connect app catalogue — searchable card grid with "Load more" pagination (mirrors main). */
function AppCatalogue({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const [q, setQ] = useState('');
  const appsQuery = useInfiniteQuery({
    queryKey: ['easy-connect-apps', projectId, q],
    queryFn: ({ pageParam }) => listPipedreamApps(projectId, q || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
  });
  const [configApp, setConfigApp] = useState<{ slug: string; name: string } | null>(null);

  const apps = (appsQuery.data?.pages ?? []).flatMap((p) => p.apps);
  const notConfigured = appsQuery.isError && /501|not configured/i.test((appsQuery.error as Error)?.message ?? '');

  return (
    <div>
      <div className="px-6 pt-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps — gmail, slack, stripe, notion…" className="h-10 pl-9" />
        </div>
      </div>
      <div className="max-h-[58vh] overflow-y-auto px-6 py-4">
        {notConfigured ? (
          <InfoBanner tone="neutral" title="App connect isn't configured">
            Easy-connect apps need the connect provider configured on the API.
          </InfoBanner>
        ) : appsQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="h-[104px] w-full rounded-2xl" />)}
          </div>
        ) : apps.length === 0 ? (
          <EmptyState icon={Search} title="No apps found" description={q ? `Nothing matches "${q}".` : 'Try a search.'} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {apps.map((app) => (
                <div key={app.slug} className="flex flex-col rounded-2xl border border-border/60 bg-card p-4">
                  <div className="flex items-center gap-3">
                    {app.imgSrc ? (
                      <img src={app.imgSrc} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain" referrerPolicy="no-referrer" />
                    ) : (
                      <EntityAvatar icon={Zap} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-foreground">{app.name}</div>
                      {app.categories?.[0] && <div className="truncate text-xs text-muted-foreground">{app.categories[0]}</div>}
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed text-muted-foreground">{app.description ?? ' '}</p>
                  <div className="mt-3 flex justify-end">
                    <Button size="sm" variant="outline" className="h-7 gap-1.5 px-3 text-xs" onClick={() => setConfigApp({ slug: app.slug, name: app.name })}>
                      <Plus className="h-3.5 w-3.5" />Add
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {appsQuery.hasNextPage && (
              <div className="flex justify-center pt-5">
                <Button variant="outline" size="sm" onClick={() => appsQuery.fetchNextPage()} disabled={appsQuery.isFetchingNextPage} className="h-9 px-8">
                  {appsQuery.isFetchingNextPage ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading…</> : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <ConfigureAppDialog projectId={projectId} app={configApp} open={!!configApp} onOpenChange={(o) => !o && setConfigApp(null)} onAdded={onAdded} />
    </div>
  );
}

/** Asks credential mode + access before adding an app connector. */
function ConfigureAppDialog({
  projectId,
  app,
  open,
  onOpenChange,
  onAdded,
}: {
  projectId: string;
  app: { slug: string; name: string } | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => void;
}) {
  const [setup, setSetup] = useState<ConnectorSetup>({ credential: 'per_user', access: 'project', memberIds: [] });
  const save = useMutation({
    mutationFn: () =>
      createConnector(projectId, {
        slug: app!.slug,
        provider: 'pipedream',
        app: app!.slug,
        account: 'default',
        credential: setup.credential,
        sharing: setupToSharing(setup),
      }),
    onSuccess: () => { toast.success(`Added ${app!.name} — click Connect to authorize`); onAdded(); onOpenChange(false); },
    onError: (err: Error) => toast.error(err.message || 'Failed to add'),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>Add {app?.name}</DialogTitle>
          <DialogDescription>Choose how the credential is stored and who can use it.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[58vh] overflow-y-auto px-6 py-5">
          <ConnectorSetupFields projectId={projectId} value={setup} onChange={setSetup} />
        </div>
        <DialogFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (setup.access === 'members' && setup.memberIds.length === 0)} className="gap-1.5">
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomConnectorForm({ projectId, onAdded, onCancel }: { projectId: string; onAdded: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ConnectorDraftInput>({ slug: '', provider: 'openapi', auth: { type: 'none' } });
  const [setup, setSetup] = useState<ConnectorSetup>({ credential: 'shared', access: 'project', memberIds: [] });
  const set = (patch: Partial<ConnectorDraftInput>) => setDraft((d) => ({ ...d, ...patch }));
  const setAuth = (patch: Partial<NonNullable<ConnectorDraftInput['auth']>>) => setDraft((d) => ({ ...d, auth: { ...d.auth, ...patch } }));

  const save = useMutation({
    mutationFn: () => createConnector(projectId, { ...draft, credential: setup.credential, sharing: setupToSharing(setup) }),
    onSuccess: () => { toast.success(`Added ${draft.slug}`); onAdded(); },
    onError: (err: Error) => toast.error(err.message || 'Failed to add connector'),
  });

  const p = draft.provider;
  const needsAuth = p !== 'pipedream';

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="max-h-[58vh] space-y-4 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Slug</Label>
            <Input value={draft.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })} placeholder="my-api" className="font-mono" required />
          </div>
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={p} onValueChange={(v) => set({ provider: v as ConnectorDraftInput['provider'] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openapi">OpenAPI</SelectItem>
                <SelectItem value="graphql">GraphQL</SelectItem>
                <SelectItem value="mcp">MCP</SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {(p === 'openapi') && (
          <Field label="Spec (URL or repo path)"><Input value={draft.spec ?? ''} onChange={(e) => set({ spec: e.target.value })} placeholder="https://…/openapi.json" required /></Field>
        )}
        {p === 'graphql' && (
          <>
            <Field label="Endpoint"><Input value={draft.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://api/graphql" required /></Field>
            <Field label="SDL spec (optional)"><Input value={draft.spec ?? ''} onChange={(e) => set({ spec: e.target.value })} placeholder=".kortix/executor/schema.graphql" /></Field>
          </>
        )}
        {p === 'mcp' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="URL"><Input value={draft.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp…/mcp" required /></Field>
            <div className="space-y-1.5">
              <Label>Transport</Label>
              <Select value={draft.transport ?? 'http'} onValueChange={(v) => set({ transport: v as 'http' | 'sse' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="http">http</SelectItem><SelectItem value="sse">sse</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
        )}
        {p === 'http' && (
          <>
            <Field label="Base URL"><Input value={draft.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.internal" required /></Field>
            <Field label="Routes spec (optional)"><Input value={draft.spec ?? ''} onChange={(e) => set({ spec: e.target.value })} placeholder=".kortix/executor/routes.toml" /></Field>
          </>
        )}

        {needsAuth && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Auth</Label>
              <Select value={draft.auth?.type ?? 'none'} onValueChange={(v) => setAuth({ type: v as 'none' | 'bearer' | 'basic' | 'custom' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer">Bearer</SelectItem>
                  <SelectItem value="basic">Basic</SelectItem>
                  <SelectItem value="custom">Custom header</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.auth?.type === 'custom' && (
              <Field label="Header name"><Input value={draft.auth?.name ?? ''} onChange={(e) => setAuth({ name: e.target.value })} placeholder="X-API-Key" required /></Field>
            )}
          </div>
        )}

        {needsAuth && draft.auth?.type && draft.auth.type !== 'none' && (
          <p className="text-xs text-muted-foreground">You'll set the credential value after adding (or each member connects their own, per the mode below).</p>
        )}

        <div className="border-t border-border/60 pt-4">
          <ConnectorSetupFields projectId={projectId} value={setup} onChange={setSetup} />
        </div>
      </div>
      <DialogFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>Cancel</Button>
        <Button type="submit" disabled={!draft.slug || save.isPending || (setup.access === 'members' && setup.memberIds.length === 0)} className="gap-1.5">
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Add
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

// ─── Set credential (non-pipedream) ─────────────────────────────────────────

function SetCredentialDialog({
  projectId,
  connector,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  connector: AdminConnector | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => setConnectorCredential(projectId, connector!.slug, value),
    onSuccess: () => { toast.success('Credential saved'); setValue(''); onSaved(); onOpenChange(false); },
    onError: (err: Error) => toast.error(err.message || 'Failed to save'),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>Set credential for {connector?.slug}</DialogTitle>
          <DialogDescription>
            Stored encrypted as <code className="font-mono">{connector?.authSecret}</code> and resolved server-side — never injected into the sandbox.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (value) save.mutate(); }}>
          <div className="space-y-1.5 px-6 py-5">
            <Label>Value</Label>
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="••••••••" className="font-mono" autoFocus />
          </div>
          <DialogFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" disabled={!value || save.isPending} className="gap-1.5">{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Source viewer — tools + schema + TS signature ──────────────────────────

function ConnectorToolsDialog({ connector, open, onOpenChange }: { connector: AdminConnector | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const action = useMemo(
    () => connector?.actions.find((a) => a.path === selected) ?? connector?.actions[0] ?? null,
    [connector, selected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>{connector?.slug}</DialogTitle>
          <DialogDescription>{connector?.actions.length ?? 0} tools · provider {connector?.provider}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] min-h-[18rem]">
          <div className="w-56 shrink-0 overflow-y-auto border-r border-border/60 py-2">
            {(connector?.actions ?? []).length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">No tools yet — Sync after the credential is set.</p>
            ) : (
              (connector?.actions ?? []).map((a) => (
                <button
                  key={a.path}
                  onClick={() => setSelected(a.path)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${action?.path === a.path ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
                >
                  <span className="truncate font-mono text-xs">{a.path}</span>
                </button>
              ))
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {action ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-sm text-foreground">{connector?.slug}.{action.path}</code>
                  <Badge variant={RISK_VARIANT[action.risk]} size="sm">{action.risk}</Badge>
                </div>
                {action.description && <p className="text-sm text-muted-foreground">{action.description}</p>}
                <div className="space-y-1.5">
                  <Label>TypeScript</Label>
                  <pre className="overflow-x-auto rounded-2xl border border-border/60 bg-muted/40 p-3 font-mono text-xs text-foreground">{tsSignature(connector!.slug, action)}</pre>
                </div>
                <div className="space-y-1.5">
                  <Label>Input schema</Label>
                  <pre className="max-h-64 overflow-auto rounded-2xl border border-border/60 bg-muted/40 p-3 font-mono text-xs text-foreground">{JSON.stringify(action.inputSchema ?? { type: 'object', properties: {} }, null, 2)}</pre>
                </div>
              </div>
            ) : (
              <EmptyState icon={Wrench} title="No tool selected" description="Pick a tool on the left." />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function tsSignature(slug: string, action: ConnectorAction): string {
  const props = (action.inputSchema as any)?.properties ?? {};
  const required: string[] = (action.inputSchema as any)?.required ?? [];
  const args = Object.entries(props).map(([k, v]: [string, any]) => {
    const t = v?.type === 'integer' ? 'number' : (v?.type ?? 'string');
    return `  ${k}${required.includes(k) ? '' : '?'}: ${t};`;
  });
  const argBlock = args.length ? `{\n${args.join('\n')}\n}` : '{}';
  return `executor.call("${slug}", "${action.path}", ${argBlock}): Promise<unknown>`;
}

// ─── Sharing picker — the 3 options ─────────────────────────────────────────

function ConnectorSharingDialog({
  projectId,
  connector,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  connector: AdminConnector | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<'project' | 'private' | 'members'>('project');
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const membersQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    enabled: open && mode === 'members',
    staleTime: 30_000,
  });

  useMemo(() => {
    if (!open || !connector) return;
    const s = connector.sharing;
    if (!s || s.mode === 'project') { setMode('project'); setMemberIds([]); }
    else if (s.mode === 'private') { setMode('private'); setMemberIds([]); }
    else { setMode('members'); setMemberIds(s.memberIds ?? []); }
  }, [open, connector]);

  const save = useMutation({
    mutationFn: () => {
      const intent: ConnectorSharing =
        mode === 'project' ? { mode: 'project' }
        : mode === 'private' ? { mode: 'private', ownerId: '' }
        : { mode: 'members', memberIds };
      return setConnectorSharing(projectId, connector!.slug, intent);
    },
    onSuccess: () => { toast.success('Sharing updated'); onSaved(); onOpenChange(false); },
    onError: (err: Error) => toast.error(err.message || 'Failed to update sharing'),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>Who can use {connector?.slug}?</DialogTitle>
          <DialogDescription>Controls which members' sessions can call this connector.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5">
          {connector && !connector.secretSet && (
            <InfoBanner tone="neutral" title="Credential not set">Set the credential (or connect the account) before sharing takes effect.</InfoBanner>
          )}
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="space-y-2">
            <ShareOption value="project" label="Project-wide" desc="Every member of this project" current={mode} />
            <ShareOption value="private" label="Only me" desc="Just you" current={mode} />
            <ShareOption value="members" label="Select members" desc="A chosen list of members" current={mode} />
          </RadioGroup>
          {mode === 'members' && (
            <div className="space-y-2 rounded-2xl border border-border/60 p-3">
              {membersQuery.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                (membersQuery.data?.members ?? []).map((m) => (
                  <label key={m.user_id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={memberIds.includes(m.user_id)}
                      onCheckedChange={(c) => setMemberIds((prev) => (c ? [...prev, m.user_id] : prev.filter((id) => id !== m.user_id)))}
                    />
                    <span className="truncate">{m.email ?? m.user_id}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>
        <DialogFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (mode === 'members' && memberIds.length === 0)} className="gap-1.5">
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareOption({ value, label, desc, current }: { value: string; label: string; desc: string; current: string }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 transition-colors ${current === value ? 'border-primary/50 bg-primary/[0.04]' : 'border-border/60 hover:bg-muted/40'}`}>
      <RadioGroupItem value={value} className="mt-0.5" />
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </label>
  );
}

function ConnectorsSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="border-b border-border/60 px-6 py-4"><Skeleton className="h-8 w-full" /></div>
      <div className="divide-y divide-border/60">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-6 py-3">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto h-4 w-24" />
          </div>
        ))}
      </div>
    </Card>
  );
}
