'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, use, useEffect, useMemo, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  DatabaseZap,
  ExternalLink,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  Settings2,
  ShieldCheck,
  SquareActivity,
  Trash2,
  UserRound,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  createProjectExecutorConnectToken,
  createProjectExecutorSource,
  deleteProjectExecutorSource,
  listProjectExecutorApps,
  listProjectExecutorSources,
  listProjectSecrets,
  syncProjectExecutorPipedream,
  updateProjectExecutorSource,
  upsertProjectSecret,
  type ProjectExecutorCatalogApp,
  type ProjectExecutorSource,
  type ProjectExecutorTool,
} from '@/lib/projects-client';

type ExecutorSection = 'sources' | 'tools' | 'accounts' | 'secrets' | 'policies' | 'runtime';
type SourceType = 'mcp' | 'openapi' | 'graphql' | 'pipedream';
type ConnectMethod = SourceType;
type ManualSourceType = Exclude<SourceType, 'pipedream'>;
type CredentialMode =
  | 'none'
  | 'bearer'
  | 'api_key_header'
  | 'api_key_query'
  | 'basic'
  | 'custom'
  | 'oauth2_client_credentials';

type CredentialRow = {
  id: string;
  name: string;
  secretName: string;
  value: string;
  prefix: string;
};

const SOURCE_TYPES: readonly { value: SourceType; label: string }[] = [
  { value: 'mcp', label: 'MCP' },
  { value: 'openapi', label: 'OpenAPI' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'pipedream', label: 'Pipedream' },
];

const SECTIONS: readonly {
  value: ExecutorSection;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: 'sources', label: 'Sources', icon: DatabaseZap },
  { value: 'tools', label: 'Tools', icon: Wrench },
  { value: 'accounts', label: 'Accounts', icon: UserRound },
  { value: 'secrets', label: 'Secrets', icon: KeyRound },
  { value: 'policies', label: 'Policies', icon: ShieldCheck },
  { value: 'runtime', label: 'Session MCP', icon: SquareActivity },
];

const CONNECT_METHODS: readonly {
  value: ConnectMethod;
  label: string;
  description: string;
  icon: LucideIcon;
  badge?: string;
}[] = [
  {
    value: 'pipedream',
    label: 'Pipedream',
    description: 'OAuth/API-key app catalog',
    icon: Plug,
    badge: '3000+',
  },
  {
    value: 'mcp',
    label: 'MCP',
    description: 'Remote MCP server',
    icon: Boxes,
  },
  {
    value: 'openapi',
    label: 'OpenAPI',
    description: 'REST API spec',
    icon: DatabaseZap,
  },
  {
    value: 'graphql',
    label: 'GraphQL',
    description: 'GraphQL endpoint',
    icon: Server,
  },
];

type PopularSourcePreset = {
  id: string;
  name: string;
  summary: string;
  url: string;
  baseUrl?: string;
  icon?: string;
  method: ManualSourceType;
};

const POPULAR_SOURCE_PRESETS: readonly PopularSourcePreset[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    summary: 'Payments, subscriptions, customers, and invoices.',
    url: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
    baseUrl: 'https://api.stripe.com',
    icon: 'https://stripe.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'github-rest',
    name: 'GitHub REST',
    summary: 'Repos, issues, pull requests, actions, and users.',
    url: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
    baseUrl: 'https://api.github.com',
    icon: 'https://github.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    summary: 'Deployments, domains, projects, and edge config.',
    url: 'https://openapi.vercel.sh',
    baseUrl: 'https://api.vercel.com',
    icon: 'https://vercel.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    summary: 'DNS, workers, pages, R2, and security rules.',
    url: 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json',
    baseUrl: 'https://api.cloudflare.com/client/v4',
    icon: 'https://cloudflare.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'neon',
    name: 'Neon',
    summary: 'Serverless Postgres - projects, branches, and endpoints.',
    url: 'https://neon.tech/api_spec/release/v2.json',
    baseUrl: 'https://console.neon.tech/api/v2',
    icon: 'https://neon.tech/favicon/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    summary: 'Models, files, responses, and fine-tuning.',
    url: 'https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml',
    baseUrl: 'https://api.openai.com/v1',
    icon: 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg',
    method: 'openapi',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    summary: 'Error tracking, performance monitoring, and releases.',
    url: 'https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi-derefed.json',
    baseUrl: 'https://sentry.io/api/0',
    icon: 'https://sentry-brand.storage.googleapis.com/sentry-glyph-black.png',
    method: 'openapi',
  },
  {
    id: 'exa',
    name: 'Exa',
    summary: 'Web search, similar links, content retrieval, and answers.',
    url: 'https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-openapi-spec.yaml',
    baseUrl: 'https://api.exa.ai',
    icon: 'https://exa.ai/images/favicon-32x32.png',
    method: 'openapi',
  },
  {
    id: 'exa-websets',
    name: 'Exa Websets',
    summary: 'Websets, enrichments, webhooks, and monitors.',
    url: 'https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-websets-spec.yaml',
    baseUrl: 'https://api.exa.ai',
    icon: 'https://exa.ai/images/favicon-32x32.png',
    method: 'openapi',
  },
  {
    id: 'axiom',
    name: 'Axiom',
    summary: 'Log ingestion, querying, datasets, and monitors.',
    url: 'https://axiom.co/docs/restapi/versions/v2.json',
    baseUrl: 'https://api.axiom.co',
    icon: 'https://axiom.co/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'asana',
    name: 'Asana',
    summary: 'Tasks, projects, teams, and workspace management.',
    url: 'https://raw.githubusercontent.com/APIs-guru/openapi-directory/main/APIs/asana.com/1.0/openapi.yaml',
    baseUrl: 'https://app.asana.com/api/1.0',
    icon: 'https://asana.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    summary: 'SMS, voice, video, and messaging APIs.',
    url: 'https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json',
    baseUrl: 'https://api.twilio.com',
    icon: 'https://twilio.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    summary: 'Droplets, Kubernetes, databases, and networking.',
    url: 'https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml',
    baseUrl: 'https://api.digitalocean.com/v2',
    icon: 'https://assets.digitalocean.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'petstore',
    name: 'Petstore',
    summary: 'Classic OpenAPI demo - no auth required.',
    url: 'https://petstore3.swagger.io/api/v3/openapi.json',
    baseUrl: 'https://petstore3.swagger.io/api/v3',
    icon: 'https://petstore3.swagger.io/favicon-32x32.png',
    method: 'openapi',
  },
  {
    id: 'val-town',
    name: 'Val Town',
    summary: 'Vals, runs, blobs, and email/web endpoints.',
    url: 'https://api.val.town/openapi.json',
    baseUrl: 'https://api.val.town/v1',
    icon: 'https://www.val.town/favicon.svg',
    method: 'openapi',
  },
  {
    id: 'resend',
    name: 'Resend',
    summary: 'Transactional email sending and domain management.',
    url: 'https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml',
    baseUrl: 'https://api.resend.com',
    icon: 'https://resend.com/static/favicons/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'spotify',
    name: 'Spotify',
    summary: 'Tracks, albums, playlists, library, and playback.',
    url: 'https://raw.githubusercontent.com/sonallux/spotify-web-api/refs/heads/main/official-spotify-open-api.yml',
    baseUrl: 'https://api.spotify.com/v1',
    icon: 'https://spotify.com/favicon.ico',
    method: 'openapi',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    summary: 'Search and read documentation from any GitHub repo.',
    url: 'https://mcp.deepwiki.com/mcp',
    icon: 'https://deepwiki.com/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'context7',
    name: 'Context7',
    summary: 'Up-to-date docs and code examples for any library.',
    url: 'https://mcp.context7.com/mcp',
    icon: 'https://context7.com/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'browserbase',
    name: 'Browserbase',
    summary: 'Cloud browser sessions for web scraping and automation.',
    url: 'https://mcp.browserbase.com/mcp',
    icon: 'https://www.browserbase.com/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    summary: 'Crawl and scrape websites into structured data.',
    url: 'https://mcp.firecrawl.dev/mcp',
    icon: 'https://www.firecrawl.dev/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'neon-mcp',
    name: 'Neon',
    summary: 'Serverless Postgres - branches, queries, and management.',
    url: 'https://mcp.neon.tech/mcp',
    icon: 'https://neon.tech/favicon/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'axiom-mcp',
    name: 'Axiom',
    summary: 'Query, analyze, and monitor your logs and event data.',
    url: 'https://mcp.axiom.co/mcp',
    icon: 'https://axiom.co/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'stripe-mcp',
    name: 'Stripe',
    summary: 'Manage payments, subscriptions, and billing via MCP.',
    url: 'https://mcp.stripe.com',
    icon: 'https://stripe.com/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'linear-mcp',
    name: 'Linear',
    summary: 'Issues, projects, teams, and cycles via MCP.',
    url: 'https://mcp.linear.app/mcp',
    icon: 'https://linear.app/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    summary: 'Databases, pages, blocks, and search via MCP.',
    url: 'https://mcp.notion.com/mcp',
    icon: 'https://www.notion.com/front-static/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'sentry-mcp',
    name: 'Sentry',
    summary: 'Error monitoring, issues, and performance data.',
    url: 'https://mcp.sentry.dev/mcp',
    icon: 'https://sentry-brand.storage.googleapis.com/sentry-glyph-black.png',
    method: 'mcp',
  },
  {
    id: 'cloudflare-mcp',
    name: 'Cloudflare',
    summary: 'Workers, KV, D1, R2, and DNS management via MCP.',
    url: 'https://mcp.cloudflare.com/mcp',
    icon: 'https://cloudflare.com/favicon.ico',
    method: 'mcp',
  },
  {
    id: 'github-graphql',
    name: 'GitHub GraphQL',
    summary: "Repos, issues, PRs, and users via GitHub's GraphQL API.",
    url: 'https://api.github.com/graphql',
    icon: 'https://github.com/favicon.ico',
    method: 'graphql',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    summary: 'Projects, merge requests, pipelines, and users.',
    url: 'https://gitlab.com/api/graphql',
    icon: 'https://gitlab.com/favicon.ico',
    method: 'graphql',
  },
  {
    id: 'linear-graphql',
    name: 'Linear',
    summary: 'Issues, projects, teams, and cycles.',
    url: 'https://api.linear.app/graphql',
    icon: 'https://linear.app/favicon.ico',
    method: 'graphql',
  },
  {
    id: 'monday',
    name: 'Monday.com',
    summary: 'Boards, items, columns, and workspace automation.',
    url: 'https://api.monday.com/v2',
    icon: 'https://monday.com/favicon.ico',
    method: 'graphql',
  },
  {
    id: 'anilist',
    name: 'AniList',
    summary: 'Anime and manga database - no auth required.',
    url: 'https://graphql.anilist.co',
    icon: 'https://anilist.co/img/icons/favicon-32x32.png',
    method: 'graphql',
  },
];

export default function ProjectExecutorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Boxes className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Executor</h1>
        <Badge variant="secondary" size="sm" className="ml-auto rounded-md">
          Project scoped
        </Badge>
      </div>
      <ProjectExecutorBody projectId={projectId} />
    </div>
  );
}

function ProjectExecutorBody({ projectId }: { projectId: string }) {
  const [active, setActive] = useState<ExecutorSection>('sources');
  const [handledConnectReturn, setHandledConnectReturn] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sourcesQuery = useQuery({
    queryKey: ['project-executor-sources', projectId],
    queryFn: () => listProjectExecutorSources(projectId),
    staleTime: 10_000,
  });

  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
  });

  const syncMutation = useMutation({
    mutationFn: () => syncProjectExecutorPipedream(projectId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['project-executor-sources', projectId] });
      toast.success(
        result.synced > 0
          ? `Synced ${result.synced} Pipedream account${result.synced === 1 ? '' : 's'}`
          : 'Pipedream accounts synced',
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to sync Pipedream accounts');
    },
  });

  useEffect(() => {
    const status = searchParams.get('executor_connect');
    if (!status || handledConnectReturn) return;

    setHandledConnectReturn(true);
    if (status === 'success') {
      syncMutation.mutate();
    } else if (status === 'error') {
      toast.error('Pipedream connection was not completed');
    }
    router.replace(pathname, { scroll: false });
  }, [handledConnectReturn, pathname, router, searchParams, syncMutation]);

  const sources = useMemo(() => sourcesQuery.data?.items ?? [], [sourcesQuery.data?.items]);
  const tools = useMemo(
    () => sources.flatMap((source) => source.tools.map((tool) => ({ source, tool }))),
    [sources],
  );
  const pipedreamSources = sources.filter((source) => source.source_type === 'pipedream').length;
  const enabledSources = sources.filter((source) => source.enabled).length;
  const secretCount = secretsQuery.data?.items.length ?? 0;

  const deleteMutation = useMutation({
    mutationFn: (sourceId: string) => deleteProjectExecutorSource(projectId, sourceId),
    onSuccess: () => {
      toast.success('Source removed');
      queryClient.invalidateQueries({ queryKey: ['project-executor-sources', projectId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to remove source');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { sourceId: string; enabled: boolean }) =>
      updateProjectExecutorSource(projectId, input.sourceId, { enabled: input.enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-executor-sources', projectId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update source');
    },
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-6 lg:py-8">
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Sources" value={sources.length} sub={`${enabledSources} enabled`} />
          <Metric label="Pipedream" value={pipedreamSources} sub="Connected apps" />
          <Metric label="Tools" value={tools.length} sub="MCP visible" />
          <Metric label="Runtime" value="/mcp" sub="Session scoped" monospace />
        </div>

        <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
          <aside className="h-fit rounded-md border border-border/70 bg-card p-2">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const selected = active === section.value;
              return (
                <button
                  key={section.value}
                  type="button"
                  onClick={() => setActive(section.value)}
                  className={cn(
                    'flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium transition-colors',
                    selected
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{section.label}</span>
                </button>
              );
            })}
          </aside>

          <main className="min-w-0">
            {active === 'sources' && (
              <SourcesPanel
                projectId={projectId}
                sources={sources}
                loading={sourcesQuery.isLoading}
                deleting={deleteMutation.isPending}
                updating={updateMutation.isPending}
                syncing={syncMutation.isPending}
                onDelete={(sourceId) => deleteMutation.mutate(sourceId)}
                onToggle={(sourceId, enabled) => updateMutation.mutate({ sourceId, enabled })}
                onSync={() => syncMutation.mutate()}
              />
            )}
            {active === 'tools' && (
              <ToolsPanel tools={tools} loading={sourcesQuery.isLoading} />
            )}
            {active === 'accounts' && (
              <AccountsPanel sources={sources} loading={sourcesQuery.isLoading} />
            )}
            {active === 'secrets' && (
              <SecretsPanel
                projectId={projectId}
                loading={secretsQuery.isLoading}
                secrets={secretsQuery.data?.items ?? []}
              />
            )}
            {active === 'policies' && (
              <PoliciesPanel sources={sources} tools={tools.map((entry) => entry.tool)} />
            )}
            {active === 'runtime' && (
              <RuntimePanel projectId={projectId} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  monospace,
}: {
  label: string;
  value: string | number;
  sub: string;
  monospace?: boolean;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-card px-4 py-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold text-foreground', monospace && 'font-mono text-base')}>
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function SourcesPanel({
  projectId,
  sources,
  loading,
  deleting,
  updating,
  syncing,
  onDelete,
  onToggle,
  onSync,
}: {
  projectId: string;
  sources: ProjectExecutorSource[];
  loading: boolean;
  deleting: boolean;
  updating: boolean;
  syncing: boolean;
  onDelete: (sourceId: string) => void;
  onToggle: (sourceId: string, enabled: boolean) => void;
  onSync: () => void;
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectMethod, setConnectMethod] = useState<ConnectMethod>('pipedream');

  function openConnect(method: ConnectMethod = 'pipedream') {
    setConnectMethod(method);
    setConnectOpen(true);
  }

  return (
    <div className="space-y-5">
      <section className="rounded-md border border-border/70 bg-card">
        <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Sources</h2>
            <p className="text-xs text-muted-foreground">
              Add Pipedream apps, MCP servers, OpenAPI specs, and GraphQL APIs to the session MCP.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-md"
              disabled={syncing}
              onClick={onSync}
            >
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-md"
              onClick={() => openConnect('mcp')}
            >
              <Settings2 className="h-3.5 w-3.5" />
              Add source
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-md"
              onClick={() => openConnect('pipedream')}
            >
              <Plug className="h-3.5 w-3.5" />
              Connect
            </Button>
          </div>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => openConnect('pipedream')}
            className="group rounded-md border border-border/70 bg-background p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600">
                  <Plug className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">Pipedream app catalog</p>
                    <Badge variant="success" size="sm" className="rounded-md">
                      Default
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Search popular apps and connect OAuth/API-key profiles in one click.
                  </p>
                </div>
              </div>
              <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => openConnect('mcp')}
            className="group rounded-md border border-border/70 bg-background p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <DatabaseZap className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Protocol sources</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Browse Executor presets or add an MCP, OpenAPI, or GraphQL source manually.
                  </p>
                </div>
              </div>
              <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
            </div>
          </button>
        </div>
      </section>

      <section className="min-h-[420px] rounded-md border border-border/70 bg-card">
        <div className="flex h-14 items-center justify-between border-b border-border/60 px-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Project Sources</h2>
            <p className="text-xs text-muted-foreground">{sources.length} configured</p>
          </div>
          <Badge variant="secondary" size="sm" className="rounded-md">
            Executor MCP
          </Badge>
        </div>

        {loading ? (
          <SkeletonList />
        ) : sources.length === 0 ? (
          <EmptyState
            icon={DatabaseZap}
            title="No sources"
            detail="Click Connect to add a Pipedream app, MCP server, OpenAPI spec, or GraphQL endpoint."
          />
        ) : (
          <div className="divide-y divide-border/60">
            {sources.map((source) => (
              <SourceRow
                key={source.connection_id}
                source={source}
                deleting={deleting}
                updating={updating}
                onDelete={() => onDelete(source.connection_id)}
                onToggle={(enabled) => onToggle(source.connection_id, enabled)}
              />
            ))}
          </div>
        )}
      </section>

      <ConnectSourceDialog
        projectId={projectId}
        open={connectOpen}
        onOpenChange={setConnectOpen}
        sources={sources}
        method={connectMethod}
        onMethodChange={setConnectMethod}
      />
    </div>
  );
}

function ConnectSourceDialog({
  projectId,
  open,
  onOpenChange,
  sources,
  method,
  onMethodChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: ProjectExecutorSource[];
  method: ConnectMethod;
  onMethodChange: (method: ConnectMethod) => void;
}) {
  const [search, setSearch] = useState('');
  const [connectingApp, setConnectingApp] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PopularSourcePreset | null>(null);
  const normalizedSearch = search.trim();
  const selectedMethod = CONNECT_METHODS.find((entry) => entry.value === method) ?? CONNECT_METHODS[0];
  const methodPresets = useMemo(
    () => method === 'pipedream'
      ? []
      : POPULAR_SOURCE_PRESETS.filter((preset) => preset.method === method),
    [method],
  );
  const connectedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of sources) {
      if (source.source_type !== 'pipedream') continue;
      const app = readString(source.config.app);
      if (!app) continue;
      counts.set(app, (counts.get(app) ?? 0) + 1);
    }
    return counts;
  }, [sources]);

  const appsQuery = useInfiniteQuery({
    queryKey: ['project-executor-apps', projectId, normalizedSearch],
    queryFn: ({ pageParam }) =>
      listProjectExecutorApps(projectId, {
        q: normalizedSearch || undefined,
        cursor: pageParam,
        limit: 48,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasMore ? lastPage.pageInfo.endCursor : undefined,
    enabled: open && method === 'pipedream',
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const connectMutation = useMutation({
    mutationFn: (app: ProjectExecutorCatalogApp) => createProjectExecutorConnectToken(projectId, app.slug),
    onSuccess: (result, app) => {
      if (result.connectUrl) {
        window.location.assign(result.connectUrl);
        return;
      }
      toast.error(`Pipedream did not return a connect URL for ${app.name}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to start Pipedream connect');
    },
    onSettled: () => setConnectingApp(null),
  });

  const apps = appsQuery.data?.pages.flatMap((page) => page.apps) ?? [];
  const totalCount = appsQuery.data?.pages[0]?.pageInfo.totalCount;

  function connect(app: ProjectExecutorCatalogApp) {
    setConnectingApp(app.slug);
    connectMutation.mutate(app);
  }

  useEffect(() => {
    if (selectedPreset && selectedPreset.method !== method) {
      setSelectedPreset(null);
    }
  }, [method, selectedPreset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100vh-2rem)] max-h-[860px] overflow-hidden p-0 sm:h-[86vh] sm:max-w-6xl">
        <div className="grid h-full min-h-0 lg:grid-cols-[250px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-b border-border/60 bg-muted/20 p-4 lg:border-r lg:border-b-0">
            <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Connect method
            </div>
            <div className="space-y-2">
              {CONNECT_METHODS.map((entry) => {
                const Icon = entry.icon;
                const selected = method === entry.value;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    onClick={() => onMethodChange(entry.value)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-primary/40 bg-background text-foreground shadow-sm'
                        : 'border-border/70 bg-background/60 text-muted-foreground hover:bg-background hover:text-foreground',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                        selected
                          ? entry.value === 'pipedream'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold">{entry.label}</p>
                        {entry.badge && (
                          <Badge variant="secondary" size="sm" className="rounded-md text-[10px]">
                            {entry.badge}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs opacity-80">{entry.description}</p>
                    </div>
                    {selected && <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-emerald-500" />}
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="flex min-h-0 flex-col">
            <DialogHeader className="border-b border-border/60 px-5 py-4">
              <DialogTitle className="text-base">Connect Source</DialogTitle>
              <DialogDescription>
                {method === 'pipedream'
                  ? 'Pick a Pipedream app and connect an account profile. Connected apps are synced into project-scoped Executor sources.'
                  : `Configure a ${selectedMethod.label} source and expose its first tool through the session MCP.`}
              </DialogDescription>
            </DialogHeader>

            {method === 'pipedream' ? (
              <>
                <div className="border-b border-border/60 px-5 py-4">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="executor-pipedream-app-search"
                      name="executor-pipedream-app-search"
                      aria-label="Search Pipedream apps"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search Slack, Stripe, GitHub, Notion, Linear..."
                      className="h-10 rounded-md pl-9"
                      autoFocus
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" size="sm" className="rounded-md">
                      Pipedream selected
                    </Badge>
                    <span>
                      {typeof totalCount === 'number'
                        ? `${totalCount.toLocaleString()} apps available`
                        : 'Popular apps loaded first'}
                    </span>
                  </div>
                </div>

                <ScrollArea className="min-h-0 flex-1">
                  <div className="p-5">
                    {appsQuery.isLoading ? (
                      <AppGridSkeleton />
                    ) : appsQuery.isError ? (
                      <EmptyState
                        icon={Plug}
                        title="Pipedream catalog unavailable"
                        detail="Check the Pipedream credentials on the API and reload this dialog."
                      />
                    ) : apps.length === 0 ? (
                      <EmptyState
                        icon={Search}
                        title="No apps found"
                        detail={normalizedSearch ? `No Pipedream apps matched "${normalizedSearch}".` : 'No apps were returned from Pipedream.'}
                      />
                    ) : (
                      <>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {apps.map((app) => (
                            <AppCatalogCard
                              key={app.slug}
                              app={app}
                              connectedCount={connectedCounts.get(app.slug) ?? 0}
                              connecting={connectingApp === app.slug}
                              onConnect={() => connect(app)}
                            />
                          ))}
                        </div>

                        {appsQuery.hasNextPage && (
                          <div className="mt-5 flex justify-center">
                            <Button
                              type="button"
                              variant="outline"
                              className="h-9 rounded-md"
                              disabled={appsQuery.isFetchingNextPage}
                              onClick={() => appsQuery.fetchNextPage()}
                            >
                              {appsQuery.isFetchingNextPage ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Plus className="h-4 w-4" />
                              )}
                              Load more apps
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </ScrollArea>
              </>
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <ProtocolSourceBuilder
                  projectId={projectId}
                  method={method}
                  presets={methodPresets}
                  selectedPreset={selectedPreset}
                  onSelectPreset={setSelectedPreset}
                  onCreated={() => onOpenChange(false)}
                />
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProtocolSourceBuilder({
  projectId,
  method,
  presets,
  selectedPreset,
  onSelectPreset,
  onCreated,
}: {
  projectId: string;
  method: ManualSourceType;
  presets: readonly PopularSourcePreset[];
  selectedPreset: PopularSourcePreset | null;
  onSelectPreset: (preset: PopularSourcePreset | null) => void;
  onCreated: () => void;
}) {
  const methodLabel = SOURCE_TYPES.find((entry) => entry.value === method)?.label ?? 'Source';

  return (
    <div className="space-y-5 p-5">
      <section className="rounded-md border border-border/70 bg-background px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" size="sm" className="rounded-md">
                {methodLabel}
              </Badge>
              <h3 className="text-sm font-semibold text-foreground">Source setup</h3>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Browse Executor reference sources on the left, then add a project source on the right. Presets only prefill the form; credentials stay in project secrets.
            </p>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-3 lg:w-[420px]">
            <ProtocolSetupStat label="Reference" value={selectedPreset?.id ?? 'custom'} />
            <ProtocolSetupStat label="Namespace" value={selectedPreset ? normalizeNamespace(selectedPreset.id) : 'manual'} />
            <ProtocolSetupStat label="Runtime" value={implementationKindForSource(method)} />
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.95fr)_minmax(460px,1.05fr)] xl:items-start">
        <PopularSourceGrid
          method={method}
          presets={presets}
          selectedPresetId={selectedPreset?.id ?? null}
          onPick={onSelectPreset}
        />
        <ManualSourceForm
          projectId={projectId}
          sourceType={method}
          preset={selectedPreset}
          onClearPreset={() => onSelectPreset(null)}
          onCreated={onCreated}
        />
      </div>
    </div>
  );
}

function ProtocolSetupStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <code className="mt-1 block truncate font-mono text-[11px] text-foreground">{value}</code>
    </div>
  );
}

function AppCatalogCard({
  app,
  connectedCount,
  connecting,
  onConnect,
}: {
  app: ProjectExecutorCatalogApp;
  connectedCount: number;
  connecting: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex min-h-[148px] flex-col rounded-md border border-border/70 bg-background p-4">
      <div className="flex items-start gap-3">
        <AppLogo app={app} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{app.name}</p>
            {connectedCount > 0 && (
              <Badge variant="success" size="sm" className="rounded-md">
                {connectedCount}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {app.categories.slice(0, 2).map((category) => (
              <Badge key={category} variant="outline" size="sm" className="rounded-md text-[10px]">
                {category}
              </Badge>
            ))}
            {app.authType && (
              <Badge variant="secondary" size="sm" className="rounded-md text-[10px] uppercase">
                {app.authType}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
        {app.description || 'Connect this app through Pipedream and expose it to Executor sessions.'}
      </p>

      <div className="mt-auto flex items-center justify-end pt-3">
        <Button
          type="button"
          size="sm"
          className="h-8 rounded-md"
          disabled={connecting}
          onClick={onConnect}
        >
          {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
          {connectedCount > 0 ? 'Add account' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}

function PopularSourceGrid({
  method,
  presets,
  selectedPresetId,
  onPick,
}: {
  method: ManualSourceType;
  presets: readonly PopularSourcePreset[];
  selectedPresetId: string | null;
  onPick: (preset: PopularSourcePreset | null) => void;
}) {
  const [presetSearch, setPresetSearch] = useState('');
  const methodLabel = SOURCE_TYPES.find((entry) => entry.value === method)?.label ?? 'Source';
  const filteredPresets = useMemo(() => {
    const query = presetSearch.trim().toLowerCase();
    if (!query) return presets;
    return presets.filter((preset) => {
      const haystack = [
        preset.id,
        preset.name,
        preset.summary,
        preset.url,
        preset.baseUrl ?? '',
        normalizeNamespace(preset.id),
        normalizePresetToolName(preset),
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [presetSearch, presets]);

  if (presets.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-md border border-border/70 bg-background">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Popular source references</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Executor presets for {methodLabel}. Select one to copy its IDs, URLs, namespace, and auth defaults into the add form.
            </p>
          </div>
          <Badge variant="secondary" size="sm" className="shrink-0 rounded-md">
            {filteredPresets.length}/{presets.length}
          </Badge>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={`executor-${method}-preset-filter`}
              name={`executor-${method}-preset-filter`}
              aria-label={`Filter ${methodLabel} source references`}
              autoComplete="off"
              value={presetSearch}
              onChange={(event) => setPresetSearch(event.target.value)}
              placeholder={`Filter ${methodLabel} references...`}
              className="h-8 rounded-md pl-8 text-xs"
            />
          </div>
          {selectedPresetId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-md"
              onClick={() => onPick(null)}
            >
              Custom
            </Button>
          )}
        </div>
      </div>
      <div className="max-h-[640px] overflow-y-auto p-3">
        {filteredPresets.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center">
            <Search className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium text-foreground">No references found</p>
            <p className="mt-1 text-xs text-muted-foreground">Try a provider name, source ID, namespace, or URL.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredPresets.map((preset) => {
              const selected = preset.id === selectedPresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onPick(preset)}
                  className={cn(
                    'rounded-md border p-3 text-left transition-colors',
                    selected
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/70 bg-card hover:border-primary/40 hover:bg-muted/30',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <SourcePresetLogo preset={preset} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-foreground">{preset.name}</p>
                        <Badge variant="outline" size="sm" className="rounded-md text-[10px]">
                          {methodLabel}
                        </Badge>
                        {selected && (
                          <Badge variant="success" size="sm" className="rounded-md text-[10px]">
                            Selected
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {preset.summary}
                      </p>
                    </div>
                    {selected && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />}
                  </div>

                  <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
                    <PresetMeta label="Reference ID" value={preset.id} />
                    <PresetMeta label="Namespace" value={normalizeNamespace(preset.id)} />
                    <PresetMeta label="Tool" value={normalizePresetToolName(preset)} />
                    <PresetMeta label="Auth" value={credentialModeLabel(defaultCredentialModeForPreset(preset))} />
                  </div>

                  <div className="mt-3 space-y-1.5">
                    <PresetUrlLine label={method === 'openapi' ? 'Spec URL' : method === 'mcp' ? 'Server URL' : 'Endpoint'} value={preset.url} />
                    {preset.baseUrl && <PresetUrlLine label="Base URL" value={preset.baseUrl} />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function PresetMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background px-2 py-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <code className="mt-0.5 block truncate font-mono text-[11px] text-foreground">{value}</code>
    </div>
  );
}

function PresetUrlLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] sm:grid-cols-[72px_minmax(0,1fr)]">
      <span className="font-medium text-muted-foreground">{label}</span>
      <code className="truncate font-mono text-foreground">{value}</code>
    </div>
  );
}

function SourcePresetLogo({ preset }: { preset: PopularSourcePreset }) {
  const initials = preset.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  if (preset.icon) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-background">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preset.icon} alt="" className="h-6 w-6 object-contain" />
      </div>
    );
  }

  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-xs font-semibold text-muted-foreground">
      {initials || <DatabaseZap className="h-4 w-4" />}
    </div>
  );
}

function AppLogo({ app }: { app: ProjectExecutorCatalogApp }) {
  const initials = app.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  if (app.imgSrc) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={app.imgSrc} alt="" className="h-7 w-7 object-contain" />
      </div>
    );
  }

  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-xs font-semibold text-muted-foreground">
      {initials || <Plug className="h-4 w-4" />}
    </div>
  );
}

function ManualSourceForm({
  projectId,
  sourceType,
  preset,
  onClearPreset,
  onCreated,
}: {
  projectId: string;
  sourceType: ManualSourceType;
  preset: PopularSourcePreset | null;
  onClearPreset: () => void;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [namespace, setNamespace] = useState('');
  const [toolName, setToolName] = useState('');
  const [toolDescription, setToolDescription] = useState('');
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('none');
  const [primarySecretName, setPrimarySecretName] = useState('');
  const [primarySecretValue, setPrimarySecretValue] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [queryParamName, setQueryParamName] = useState('api_key');
  const [basicUsername, setBasicUsername] = useState('');
  const [basicPasswordSecretName, setBasicPasswordSecretName] = useState('');
  const [basicPasswordValue, setBasicPasswordValue] = useState('');
  const [oauthTokenUrl, setOauthTokenUrl] = useState('');
  const [oauthScopes, setOauthScopes] = useState('');
  const [oauthClientIdSecretName, setOauthClientIdSecretName] = useState('');
  const [oauthClientIdValue, setOauthClientIdValue] = useState('');
  const [oauthClientSecretName, setOauthClientSecretName] = useState('');
  const [oauthClientSecretValue, setOauthClientSecretValue] = useState('');
  const [customHeaders, setCustomHeaders] = useState<CredentialRow[]>([]);
  const [customQueryParams, setCustomQueryParams] = useState<CredentialRow[]>([]);

  const methodLabel = SOURCE_TYPES.find((entry) => entry.value === sourceType)?.label ?? 'Source';
  const endpointPlaceholder = sourceType === 'mcp'
    ? 'https://mcp.example.com/mcp'
    : sourceType === 'openapi'
      ? 'https://api.example.com/openapi.json'
      : sourceType === 'graphql'
        ? 'https://api.example.com/graphql'
        : 'Optional';
  const toolPlaceholder = sourceType === 'mcp'
    ? 'remote.tool.name'
    : sourceType === 'openapi'
      ? 'api.operation.name'
      : sourceType === 'graphql'
        ? 'graphql.query'
        : 'source.tool';

  useEffect(() => {
    if (preset && preset.method === sourceType) {
      const secretPrefix = defaultSecretPrefix(preset.name);
      const nextCredentialMode = defaultCredentialModeForPreset(preset);
      setName(preset.name);
      setEndpointUrl(preset.url);
      setBaseUrl(preset.baseUrl ?? '');
      setNamespace(normalizeNamespace(preset.id));
      setToolName(normalizePresetToolName(preset));
      setToolDescription(preset.summary);
      setCredentialMode(nextCredentialMode);
      setHeaderName(defaultHeaderNameForPreset(preset, nextCredentialMode));
      setQueryParamName(defaultQueryParamNameForPreset(preset));
      setPrimarySecretName(defaultSecretName(`${secretPrefix}_${defaultSecretSlotForMode(nextCredentialMode)}`));
      setPrimarySecretValue('');
      setBasicUsername('');
      setBasicPasswordSecretName(defaultSecretName(`${secretPrefix}_BASIC_PASSWORD`));
      setBasicPasswordValue('');
      setOauthTokenUrl('');
      setOauthScopes('');
      setOauthClientIdSecretName(defaultSecretName(`${secretPrefix}_OAUTH_CLIENT_ID`));
      setOauthClientIdValue('');
      setOauthClientSecretName(defaultSecretName(`${secretPrefix}_OAUTH_CLIENT_SECRET`));
      setOauthClientSecretValue('');
      setCustomHeaders([]);
      setCustomQueryParams([]);
      return;
    }

    setName('');
    setEndpointUrl('');
    setBaseUrl('');
    setNamespace('');
    setToolName('');
    setToolDescription('');
    setCredentialMode('none');
    setHeaderName('Authorization');
    setQueryParamName('api_key');
    setPrimarySecretName('');
    setPrimarySecretValue('');
    setBasicUsername('');
    setBasicPasswordSecretName('');
    setBasicPasswordValue('');
    setOauthTokenUrl('');
    setOauthScopes('');
    setOauthClientIdSecretName('');
    setOauthClientIdValue('');
    setOauthClientSecretName('');
    setOauthClientSecretValue('');
    setCustomHeaders([]);
    setCustomQueryParams([]);
  }, [preset, sourceType]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const endpoint = endpointUrl.trim();
      const cleanName = name.trim();
      const cleanNamespace = normalizeNamespace(namespace || cleanName);
      const credentials = buildCredentialConfig({
        mode: credentialMode,
        sourceType,
        primarySecretName,
        primarySecretValue,
        headerName,
        queryParamName,
        basicUsername,
        basicPasswordSecretName,
        basicPasswordValue,
        oauthTokenUrl,
        oauthScopes,
        oauthClientIdSecretName,
        oauthClientIdValue,
        oauthClientSecretName,
        oauthClientSecretValue,
        customHeaders,
        customQueryParams,
      });

      for (const secret of dedupeSecretWrites(credentials.secretWrites)) {
        await upsertProjectSecret(projectId, secret);
      }

      return createProjectExecutorSource(projectId, {
        name: cleanName,
        source_type: sourceType,
        config: buildSourceConfig({
          sourceType,
          name: cleanName,
          namespace: cleanNamespace,
          endpoint,
          baseUrl: baseUrl.trim(),
          preset,
          credentials,
        }),
        tool_name: toolName.trim(),
        tool_description: toolDescription.trim() || undefined,
        input_schema: inputSchemaForSource(sourceType),
        implementation: { kind: implementationKindForSource(sourceType) },
      });
    },
    onSuccess: () => {
      toast.success('Source added');
      setName('');
      setEndpointUrl('');
      setBaseUrl('');
      setNamespace('');
      setToolName('');
      setToolDescription('');
      setCredentialMode('none');
      setPrimarySecretName('');
      setPrimarySecretValue('');
      setBasicUsername('');
      setBasicPasswordSecretName('');
      setBasicPasswordValue('');
      setOauthTokenUrl('');
      setOauthScopes('');
      setOauthClientIdSecretName('');
      setOauthClientIdValue('');
      setOauthClientSecretName('');
      setOauthClientSecretValue('');
      setCustomHeaders([]);
      setCustomQueryParams([]);
      onCreated();
      queryClient.invalidateQueries({ queryKey: ['project-executor-sources', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to add source');
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !toolName.trim()) {
      toast.error('Source name and tool name are required');
      return;
    }
    if (!endpointUrl.trim()) {
      toast.error(`${methodLabel} URL is required`);
      return;
    }
    const credentials = buildCredentialConfig({
      mode: credentialMode,
      sourceType,
      primarySecretName,
      primarySecretValue,
      headerName,
      queryParamName,
      basicUsername,
      basicPasswordSecretName,
      basicPasswordValue,
      oauthTokenUrl,
      oauthScopes,
      oauthClientIdSecretName,
      oauthClientIdValue,
      oauthClientSecretName,
      oauthClientSecretValue,
      customHeaders,
      customQueryParams,
    });
    if (credentials.error) {
      toast.error(credentials.error);
      return;
    }
    createMutation.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <section className="rounded-md border border-border/70 bg-background p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" size="sm" className="rounded-md">
                Add source
              </Badge>
              <p className="text-sm font-semibold text-foreground">
                {preset ? `Prefilled from ${preset.name}` : `Add custom ${methodLabel}`}
              </p>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {preset
                ? preset.summary
                : `Create a custom ${methodLabel} source from your own endpoint and credential setup.`}
            </p>
          </div>
          {preset && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 rounded-md"
              onClick={onClearPreset}
            >
              Add custom
            </Button>
          )}
        </div>

        <div className="mt-4 grid gap-2 text-[11px] sm:grid-cols-3">
          <PresetMeta label="Reference ID" value={preset?.id ?? 'custom'} />
          <PresetMeta label="Source type" value={sourceType} />
          <PresetMeta label="Runtime" value={implementationKindForSource(sourceType)} />
        </div>
      </section>

      <section className="rounded-md border border-border/70 bg-background">
        <div className="border-b border-border/60 px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">1. Identity and tool IDs</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These IDs are what agents see through the session MCP.
          </p>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`executor-${sourceType}-source-name`}>Display name</Label>
            <Input
              id={`executor-${sourceType}-source-name`}
              name={`executor-${sourceType}-source-name`}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`${methodLabel} production`}
              className="h-9 rounded-md"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`executor-${sourceType}-namespace`}>Namespace</Label>
            <Input
              id={`executor-${sourceType}-namespace`}
              name={`executor-${sourceType}-namespace`}
              autoComplete="off"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              placeholder="stripe"
              className="h-9 rounded-md font-mono text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`executor-${sourceType}-tool-name`}>Tool name</Label>
            <Input
              id={`executor-${sourceType}-tool-name`}
              name={`executor-${sourceType}-tool-name`}
              autoComplete="off"
              value={toolName}
              onChange={(event) => setToolName(event.target.value)}
              placeholder={toolPlaceholder}
              className="h-9 rounded-md font-mono text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label>Runtime adapter</Label>
            <div className="flex h-9 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 text-xs text-muted-foreground">
              <Shield className="h-3.5 w-3.5" />
              {sourceType === 'openapi'
                ? 'Authenticated REST proxy'
                : sourceType === 'graphql'
                  ? 'Authenticated GraphQL proxy'
                  : 'Authenticated MCP JSON-RPC proxy'}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-md border border-border/70 bg-background">
        <div className="border-b border-border/60 px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">2. Endpoint reference</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            This is the source URL Executor will use to reach the API or remote server.
          </p>
        </div>
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor={`executor-${sourceType}-endpoint-url`}>
              {sourceType === 'openapi' ? 'OpenAPI spec URL' : sourceType === 'mcp' ? 'MCP server URL' : 'GraphQL endpoint'}
            </Label>
            <Input
              id={`executor-${sourceType}-endpoint-url`}
              name={`executor-${sourceType}-endpoint-url`}
              autoComplete="off"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder={endpointPlaceholder}
              className="h-9 rounded-md"
            />
          </div>

          {sourceType === 'openapi' && (
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-base-url`}>REST base URL</Label>
              <Input
                id={`executor-${sourceType}-base-url`}
                name={`executor-${sourceType}-base-url`}
                autoComplete="off"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                className="h-9 rounded-md"
              />
              <p className="text-xs text-muted-foreground">
                Optional, but needed when the tool is called with a relative path instead of an absolute URL.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor={`executor-${sourceType}-tool-description`}>Agent-facing description</Label>
            <Textarea
              id={`executor-${sourceType}-tool-description`}
              name={`executor-${sourceType}-tool-description`}
              value={toolDescription}
              onChange={(event) => setToolDescription(event.target.value)}
              placeholder="Describe what this source/tool gives the agent access to"
              className="min-h-20 rounded-md text-sm"
            />
          </div>
        </div>
      </section>

      <CredentialConfigFields
        sourceType={sourceType}
        mode={credentialMode}
        onModeChange={setCredentialMode}
        primarySecretName={primarySecretName}
        onPrimarySecretNameChange={setPrimarySecretName}
        primarySecretValue={primarySecretValue}
        onPrimarySecretValueChange={setPrimarySecretValue}
        headerName={headerName}
        onHeaderNameChange={setHeaderName}
        queryParamName={queryParamName}
        onQueryParamNameChange={setQueryParamName}
        basicUsername={basicUsername}
        onBasicUsernameChange={setBasicUsername}
        basicPasswordSecretName={basicPasswordSecretName}
        onBasicPasswordSecretNameChange={setBasicPasswordSecretName}
        basicPasswordValue={basicPasswordValue}
        onBasicPasswordValueChange={setBasicPasswordValue}
        oauthTokenUrl={oauthTokenUrl}
        onOauthTokenUrlChange={setOauthTokenUrl}
        oauthScopes={oauthScopes}
        onOauthScopesChange={setOauthScopes}
        oauthClientIdSecretName={oauthClientIdSecretName}
        onOauthClientIdSecretNameChange={setOauthClientIdSecretName}
        oauthClientIdValue={oauthClientIdValue}
        onOauthClientIdValueChange={setOauthClientIdValue}
        oauthClientSecretName={oauthClientSecretName}
        onOauthClientSecretNameChange={setOauthClientSecretName}
        oauthClientSecretValue={oauthClientSecretValue}
        onOauthClientSecretValueChange={setOauthClientSecretValue}
        customHeaders={customHeaders}
        onCustomHeadersChange={setCustomHeaders}
        customQueryParams={customQueryParams}
        onCustomQueryParamsChange={setCustomQueryParams}
      />

      <DialogFooter>
        <Button type="submit" disabled={createMutation.isPending} className="h-9 rounded-md">
          {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add {methodLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CredentialConfigFields({
  sourceType,
  mode,
  onModeChange,
  primarySecretName,
  onPrimarySecretNameChange,
  primarySecretValue,
  onPrimarySecretValueChange,
  headerName,
  onHeaderNameChange,
  queryParamName,
  onQueryParamNameChange,
  basicUsername,
  onBasicUsernameChange,
  basicPasswordSecretName,
  onBasicPasswordSecretNameChange,
  basicPasswordValue,
  onBasicPasswordValueChange,
  oauthTokenUrl,
  onOauthTokenUrlChange,
  oauthScopes,
  onOauthScopesChange,
  oauthClientIdSecretName,
  onOauthClientIdSecretNameChange,
  oauthClientIdValue,
  onOauthClientIdValueChange,
  oauthClientSecretName,
  onOauthClientSecretNameChange,
  oauthClientSecretValue,
  onOauthClientSecretValueChange,
  customHeaders,
  onCustomHeadersChange,
  customQueryParams,
  onCustomQueryParamsChange,
}: {
  sourceType: ManualSourceType;
  mode: CredentialMode;
  onModeChange: (mode: CredentialMode) => void;
  primarySecretName: string;
  onPrimarySecretNameChange: (value: string) => void;
  primarySecretValue: string;
  onPrimarySecretValueChange: (value: string) => void;
  headerName: string;
  onHeaderNameChange: (value: string) => void;
  queryParamName: string;
  onQueryParamNameChange: (value: string) => void;
  basicUsername: string;
  onBasicUsernameChange: (value: string) => void;
  basicPasswordSecretName: string;
  onBasicPasswordSecretNameChange: (value: string) => void;
  basicPasswordValue: string;
  onBasicPasswordValueChange: (value: string) => void;
  oauthTokenUrl: string;
  onOauthTokenUrlChange: (value: string) => void;
  oauthScopes: string;
  onOauthScopesChange: (value: string) => void;
  oauthClientIdSecretName: string;
  onOauthClientIdSecretNameChange: (value: string) => void;
  oauthClientIdValue: string;
  onOauthClientIdValueChange: (value: string) => void;
  oauthClientSecretName: string;
  onOauthClientSecretNameChange: (value: string) => void;
  oauthClientSecretValue: string;
  onOauthClientSecretValueChange: (value: string) => void;
  customHeaders: CredentialRow[];
  onCustomHeadersChange: (rows: CredentialRow[]) => void;
  customQueryParams: CredentialRow[];
  onCustomQueryParamsChange: (rows: CredentialRow[]) => void;
}) {
  const isHeaderMode = mode === 'bearer' || mode === 'api_key_header';
  const primaryLabel = mode === 'bearer'
    ? 'Bearer token'
    : mode === 'api_key_header'
      ? 'Header value'
      : 'Query parameter value';

  return (
    <section className="rounded-md border border-border/70 bg-background">
      <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">3. Credentials and secret bindings</h3>
          <p className="text-xs text-muted-foreground">
            Values are saved as encrypted project secrets. The source stores Executor-style slots and secret bindings.
          </p>
        </div>
        <Badge variant="secondary" size="sm" className="w-fit rounded-md">
          Project vault
        </Badge>
      </div>

      <div className="space-y-4 p-4">
        <div className="space-y-2">
          <Label
            id={`executor-${sourceType}-credential-mode-label`}
            htmlFor={`executor-${sourceType}-credential-mode`}
          >
            Authentication method
          </Label>
          <Select
            name={`executor-${sourceType}-credential-mode`}
            value={mode}
            onValueChange={(value) => onModeChange(value as CredentialMode)}
          >
            <SelectTrigger
              id={`executor-${sourceType}-credential-mode`}
              aria-label="Authentication method"
              aria-labelledby={`executor-${sourceType}-credential-mode-label`}
              className="h-9 rounded-md"
            >
              <SelectValue placeholder="Select auth method" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="bearer">Bearer token</SelectItem>
              <SelectItem value="api_key_header">API key header</SelectItem>
              <SelectItem value="api_key_query">API key query parameter</SelectItem>
              <SelectItem value="basic">Basic auth</SelectItem>
              <SelectItem value="custom">Custom headers and query parameters</SelectItem>
              <SelectItem value="oauth2_client_credentials">OAuth2 client credentials</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === 'none' && (
          <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
            No credentials will be attached to calls for this source.
          </div>
        )}

        {(mode === 'bearer' || mode === 'api_key_header' || mode === 'api_key_query') && (
          <div className="grid gap-4 sm:grid-cols-2">
            {isHeaderMode ? (
              <div className="space-y-2">
                <Label htmlFor={`executor-${sourceType}-header-name`}>Header</Label>
                <Input
                  id={`executor-${sourceType}-header-name`}
                  name={`executor-${sourceType}-header-name`}
                  autoComplete="off"
                  value={headerName}
                  onChange={(event) => onHeaderNameChange(event.target.value)}
                  placeholder="Authorization"
                  className="h-9 rounded-md font-mono text-xs"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor={`executor-${sourceType}-query-param-name`}>Query parameter</Label>
                <Input
                  id={`executor-${sourceType}-query-param-name`}
                  name={`executor-${sourceType}-query-param-name`}
                  autoComplete="off"
                  value={queryParamName}
                  onChange={(event) => onQueryParamNameChange(event.target.value)}
                  placeholder="api_key"
                  className="h-9 rounded-md font-mono text-xs"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-primary-secret-name`}>Secret name</Label>
              <Input
                id={`executor-${sourceType}-primary-secret-name`}
                name={`executor-${sourceType}-primary-secret-name`}
                autoComplete="off"
                value={primarySecretName}
                onChange={(event) => onPrimarySecretNameChange(event.target.value.toUpperCase())}
                placeholder="EXECUTOR_STRIPE_API_KEY"
                className="h-9 rounded-md font-mono text-xs"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`executor-${sourceType}-primary-secret-value`}>{primaryLabel}</Label>
              <Input
                id={`executor-${sourceType}-primary-secret-value`}
                name={`executor-${sourceType}-primary-secret-value`}
                type="password"
                autoComplete="new-password"
                value={primarySecretValue}
                onChange={(event) => onPrimarySecretValueChange(event.target.value)}
                placeholder="Stored encrypted, never written into source config"
                className="h-9 rounded-md"
              />
            </div>
          </div>
        )}

        {mode === 'basic' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-basic-username`}>Username</Label>
              <Input
                id={`executor-${sourceType}-basic-username`}
                name={`executor-${sourceType}-basic-username`}
                autoComplete="off"
                value={basicUsername}
                onChange={(event) => onBasicUsernameChange(event.target.value)}
                placeholder="account id or username"
                className="h-9 rounded-md"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-basic-secret-name`}>Password secret</Label>
              <Input
                id={`executor-${sourceType}-basic-secret-name`}
                name={`executor-${sourceType}-basic-secret-name`}
                autoComplete="off"
                value={basicPasswordSecretName}
                onChange={(event) => onBasicPasswordSecretNameChange(event.target.value.toUpperCase())}
                placeholder="EXECUTOR_API_PASSWORD"
                className="h-9 rounded-md font-mono text-xs"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`executor-${sourceType}-basic-password`}>Password</Label>
              <Input
                id={`executor-${sourceType}-basic-password`}
                name={`executor-${sourceType}-basic-password`}
                type="password"
                autoComplete="new-password"
                value={basicPasswordValue}
                onChange={(event) => onBasicPasswordValueChange(event.target.value)}
                placeholder="Stored encrypted"
                className="h-9 rounded-md"
              />
            </div>
          </div>
        )}

        {mode === 'oauth2_client_credentials' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`executor-${sourceType}-oauth-token-url`}>Token URL</Label>
              <Input
                id={`executor-${sourceType}-oauth-token-url`}
                name={`executor-${sourceType}-oauth-token-url`}
                autoComplete="off"
                value={oauthTokenUrl}
                onChange={(event) => onOauthTokenUrlChange(event.target.value)}
                placeholder="https://provider.example.com/oauth/token"
                className="h-9 rounded-md"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-oauth-client-id-secret`}>Client ID secret</Label>
              <Input
                id={`executor-${sourceType}-oauth-client-id-secret`}
                name={`executor-${sourceType}-oauth-client-id-secret`}
                autoComplete="off"
                value={oauthClientIdSecretName}
                onChange={(event) => onOauthClientIdSecretNameChange(event.target.value.toUpperCase())}
                placeholder="EXECUTOR_OAUTH_CLIENT_ID"
                className="h-9 rounded-md font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-oauth-client-secret-name`}>Client secret name</Label>
              <Input
                id={`executor-${sourceType}-oauth-client-secret-name`}
                name={`executor-${sourceType}-oauth-client-secret-name`}
                autoComplete="off"
                value={oauthClientSecretName}
                onChange={(event) => onOauthClientSecretNameChange(event.target.value.toUpperCase())}
                placeholder="EXECUTOR_OAUTH_CLIENT_SECRET"
                className="h-9 rounded-md font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-oauth-client-id`}>Client ID</Label>
              <Input
                id={`executor-${sourceType}-oauth-client-id`}
                name={`executor-${sourceType}-oauth-client-id`}
                type="password"
                autoComplete="new-password"
                value={oauthClientIdValue}
                onChange={(event) => onOauthClientIdValueChange(event.target.value)}
                placeholder="Stored encrypted"
                className="h-9 rounded-md"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`executor-${sourceType}-oauth-client-secret`}>Client secret</Label>
              <Input
                id={`executor-${sourceType}-oauth-client-secret`}
                name={`executor-${sourceType}-oauth-client-secret`}
                type="password"
                autoComplete="new-password"
                value={oauthClientSecretValue}
                onChange={(event) => onOauthClientSecretValueChange(event.target.value)}
                placeholder="Stored encrypted"
                className="h-9 rounded-md"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`executor-${sourceType}-oauth-scopes`}>Scopes</Label>
              <Input
                id={`executor-${sourceType}-oauth-scopes`}
                name={`executor-${sourceType}-oauth-scopes`}
                autoComplete="off"
                value={oauthScopes}
                onChange={(event) => onOauthScopesChange(event.target.value)}
                placeholder="read write"
                className="h-9 rounded-md"
              />
            </div>
          </div>
        )}

        {mode === 'custom' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <CredentialRowsEditor
              title="Headers"
              emptyLabel="No custom headers"
              addLabel="Add header"
              namePlaceholder="X-API-Key"
              rows={customHeaders}
              onChange={onCustomHeadersChange}
            />
            <CredentialRowsEditor
              title="Query parameters"
              emptyLabel="No custom query parameters"
              addLabel="Add query parameter"
              namePlaceholder="token"
              rows={customQueryParams}
              onChange={onCustomQueryParamsChange}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function CredentialRowsEditor({
  title,
  emptyLabel,
  addLabel,
  namePlaceholder,
  rows,
  onChange,
}: {
  title: string;
  emptyLabel: string;
  addLabel: string;
  namePlaceholder: string;
  rows: CredentialRow[];
  onChange: (rows: CredentialRow[]) => void;
}) {
  function updateRow(id: string, patch: Partial<CredentialRow>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <div className="rounded-md border border-border/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-md"
          onClick={() => onChange([...rows, createCredentialRow(title)])}
        >
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.id} className="space-y-2 rounded-md border border-border/60 p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Input
                  name={`executor-credential-name-${row.id}`}
                  autoComplete="off"
                  value={row.name}
                  onChange={(event) => updateRow(row.id, { name: event.target.value })}
                  placeholder={namePlaceholder}
                  className="h-8 rounded-md font-mono text-xs"
                />
                <Input
                  name={`executor-credential-secret-${row.id}`}
                  autoComplete="off"
                  value={row.secretName}
                  onChange={(event) => updateRow(row.id, { secretName: event.target.value.toUpperCase() })}
                  placeholder="EXECUTOR_SECRET"
                  className="h-8 rounded-md font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-md"
                  onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
                  aria-label={`Remove ${title} credential`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
                <Input
                  name={`executor-credential-prefix-${row.id}`}
                  autoComplete="off"
                  value={row.prefix}
                  onChange={(event) => updateRow(row.id, { prefix: event.target.value })}
                  placeholder="Prefix"
                  className="h-8 rounded-md text-xs"
                />
                <Input
                  type="password"
                  name={`executor-credential-${row.id}`}
                  autoComplete="new-password"
                  value={row.value}
                  onChange={(event) => updateRow(row.id, { value: event.target.value })}
                  placeholder="Secret value"
                  className="h-8 rounded-md"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceRow({
  source,
  deleting,
  updating,
  onDelete,
  onToggle,
}: {
  source: ProjectExecutorSource;
  deleting: boolean;
  updating: boolean;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const url = readString(source.config.url);
  const appName = readString(source.config.app_name);
  const providerAccountId = readString(source.config.provider_account_id);

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{appName || source.name}</p>
            <Badge variant="outline" size="sm" className="rounded-md font-mono">
              {source.source_type}
            </Badge>
            {source.enabled && (
              <Badge variant="success" size="sm" className="rounded-md">
                Enabled
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {appName && <span>{source.name}</span>}
            {providerAccountId && <code className="font-mono">{providerAccountId}</code>}
            {url && <code className="font-mono">{url}</code>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={source.enabled}
            disabled={updating}
            onCheckedChange={onToggle}
            aria-label={`Toggle ${source.name}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-md"
            disabled={deleting}
            onClick={onDelete}
            aria-label={`Delete ${source.name}`}
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        {source.tools.map((tool) => (
          <ToolInline key={tool.tool_id} tool={tool} />
        ))}
      </div>
    </div>
  );
}

function ToolsPanel({
  tools,
  loading,
}: {
  tools: { source: ProjectExecutorSource; tool: ProjectExecutorTool }[];
  loading: boolean;
}) {
  return (
    <section className="rounded-md border border-border/70 bg-card">
      <div className="flex h-14 items-center justify-between border-b border-border/60 px-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Tools</h2>
          <p className="text-xs text-muted-foreground">{tools.length} callable tools</p>
        </div>
        <Badge variant="secondary" size="sm" className="rounded-md">
          MCP
        </Badge>
      </div>

      {loading ? (
        <SkeletonList />
      ) : tools.length === 0 ? (
        <EmptyState icon={Wrench} title="No tools" detail="Connect or add a source to expose tools." />
      ) : (
        <div className="divide-y divide-border/60">
          {tools.map(({ source, tool }) => (
            <div key={tool.tool_id} className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <code className="truncate text-sm font-semibold text-foreground">{tool.name}</code>
                  <Badge variant={tool.enabled ? 'success' : 'secondary'} size="sm" className="rounded-md">
                    {tool.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                {tool.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs font-medium text-foreground">{source.name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">{source.source_type}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AccountsPanel({
  sources,
  loading,
}: {
  sources: ProjectExecutorSource[];
  loading: boolean;
}) {
  return (
    <section className="rounded-md border border-border/70 bg-card">
      <div className="flex h-14 items-center justify-between border-b border-border/60 px-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Accounts</h2>
          <p className="text-xs text-muted-foreground">{sources.length} source accounts</p>
        </div>
        <UserRound className="h-4 w-4 text-muted-foreground" />
      </div>

      {loading ? (
        <SkeletonList />
      ) : sources.length === 0 ? (
        <EmptyState icon={UserRound} title="No accounts" detail="Connected Pipedream accounts appear here." />
      ) : (
        <div className="divide-y divide-border/60">
          {sources.map((source) => (
            <div key={source.connection_id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{readString(source.config.app_name) || source.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{readString(source.config.provider_account_id) || source.connection_id}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" size="sm" className="rounded-md font-mono">
                  {source.source_type}
                </Badge>
                <Badge variant="secondary" size="sm" className="rounded-md">
                  Project
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SecretsPanel({
  projectId,
  loading,
  secrets,
}: {
  projectId: string;
  loading: boolean;
  secrets: { secret_id: string; name: string; updated_at: string }[];
}) {
  return (
    <section className="rounded-md border border-border/70 bg-card">
      <div className="flex h-14 items-center justify-between border-b border-border/60 px-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Secrets</h2>
          <p className="text-xs text-muted-foreground">{secrets.length} encrypted values</p>
        </div>
        <Button asChild variant="outline" size="sm" className="h-8 rounded-md">
          <Link href={`/projects/${projectId}/secrets`}>
            Open Vault
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      {loading ? (
        <SkeletonList />
      ) : secrets.length === 0 ? (
        <EmptyState icon={KeyRound} title="No secrets" detail="Project vault entries appear here." />
      ) : (
        <div className="divide-y divide-border/60">
          {secrets.map((secret) => (
            <div key={secret.secret_id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold text-foreground">{secret.name}</p>
                <p className="text-xs text-muted-foreground">Updated {new Date(secret.updated_at).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PoliciesPanel({
  sources,
  tools,
}: {
  sources: ProjectExecutorSource[];
  tools: ProjectExecutorTool[];
}) {
  return (
    <section className="rounded-md border border-border/70 bg-card">
      <div className="flex h-14 items-center justify-between border-b border-border/60 px-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Policies</h2>
          <p className="text-xs text-muted-foreground">{tools.length} tools covered by project access</p>
        </div>
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
      </div>

      <div className="divide-y divide-border/60">
        <PolicyRow
          pattern="project.write"
          action="Required"
          detail="Creating and changing Executor sources requires project write access."
        />
        <PolicyRow
          pattern="session.token"
          action="Scoped"
          detail="Session MCP tokens are scoped to one account, project, user, and session."
        />
        <PolicyRow
          pattern="source.enabled"
          action={sources.some((source) => source.enabled) ? 'Active' : 'Idle'}
          detail="Disabled sources are omitted from session tool discovery."
        />
      </div>
    </section>
  );
}

function RuntimePanel({ projectId }: { projectId: string }) {
  const envRows = [
    ['KORTIX_EXECUTOR_MCP_URL', '/v1/router/mcp'],
    ['KORTIX_EXECUTOR_MCP_TOKEN', 'signed session token'],
    ['KORTIX_EXECUTOR_MCP_SESSION_ID', 'current session id'],
  ];

  return (
    <section className="rounded-md border border-border/70 bg-card">
      <div className="flex h-14 items-center justify-between border-b border-border/60 px-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Session MCP</h2>
          <p className="text-xs text-muted-foreground">Project {projectId}</p>
        </div>
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      </div>

      <div className="divide-y divide-border/60">
        {envRows.map(([name, value]) => (
          <div key={name} className="grid gap-1 p-4 sm:grid-cols-[260px_1fr] sm:items-center">
            <code className="font-mono text-xs font-semibold text-foreground">{name}</code>
            <code className="min-w-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              {value}
            </code>
          </div>
        ))}
      </div>
    </section>
  );
}

function ToolInline({ tool }: { tool: ProjectExecutorTool }) {
  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <code className="truncate text-xs font-medium text-foreground">{tool.name}</code>
      </div>
      {tool.description && (
        <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
      )}
    </div>
  );
}

function PolicyRow({
  pattern,
  action,
  detail,
}: {
  pattern: string;
  action: string;
  detail: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <code className="font-mono text-sm font-semibold text-foreground">{pattern}</code>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
      <Badge variant="secondary" size="sm" className="rounded-md">
        {action}
      </Badge>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-20 rounded-md" />
      <Skeleton className="h-20 rounded-md" />
      <Skeleton className="h-20 rounded-md" />
    </div>
  );
}

function AppGridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 9 }).map((_, index) => (
        <Skeleton key={index} className="h-[148px] rounded-md" />
      ))}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex h-[280px] items-center justify-center px-6 text-center">
      <div className="max-w-sm">
        <Icon className="mx-auto h-8 w-8 text-muted-foreground/70" />
        <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
        {detail && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

type CredentialBuildResult = {
  mode: CredentialMode;
  headers: Record<string, string | { kind: 'binding'; slot: string; prefix?: string }>;
  queryParams: Record<string, string | { kind: 'binding'; slot: string; prefix?: string }>;
  auth?: Record<string, unknown>;
  credentialBindings: Array<{
    slot: string;
    kind: 'secret';
    secret_name: string;
    target_scope: 'project';
    secret_scope: 'project';
  }>;
  requiredSecretNames: string[];
  secretWrites: Array<{ name: string; value: string }>;
  error?: string;
};

function buildCredentialConfig(input: {
  mode: CredentialMode;
  sourceType: ManualSourceType;
  primarySecretName: string;
  primarySecretValue: string;
  headerName: string;
  queryParamName: string;
  basicUsername: string;
  basicPasswordSecretName: string;
  basicPasswordValue: string;
  oauthTokenUrl: string;
  oauthScopes: string;
  oauthClientIdSecretName: string;
  oauthClientIdValue: string;
  oauthClientSecretName: string;
  oauthClientSecretValue: string;
  customHeaders: CredentialRow[];
  customQueryParams: CredentialRow[];
}): CredentialBuildResult {
  const result: CredentialBuildResult = {
    mode: input.mode,
    headers: {},
    queryParams: {},
    credentialBindings: [],
    requiredSecretNames: [],
    secretWrites: [],
  };

  function bind(slot: string, rawSecretName: string, value: string, prefix?: string) {
    const secretName = normalizeSecretInput(rawSecretName);
    if (!secretName) {
      result.error = 'Secret names must be valid env vars: A-Z, 0-9, underscore, max 64 chars.';
      return null;
    }
    if (!value.trim()) {
      result.error = `Secret value is required for ${secretName}`;
      return null;
    }
    result.credentialBindings.push({
      slot,
      kind: 'secret',
      secret_name: secretName,
      target_scope: 'project',
      secret_scope: 'project',
    });
    result.requiredSecretNames.push(secretName);
    result.secretWrites.push({ name: secretName, value });
    return {
      kind: 'binding' as const,
      slot,
      ...(prefix ? { prefix } : {}),
    };
  }

  if (input.mode === 'none') return result;

  if (input.mode === 'bearer' || input.mode === 'api_key_header') {
    const header = input.headerName.trim();
    if (!header) return { ...result, error: 'Header name is required' };
    const slot = headerBindingSlot(header);
    const binding = bind(slot, input.primarySecretName, input.primarySecretValue, input.mode === 'bearer' ? 'Bearer ' : undefined);
    if (binding) result.headers[header] = binding;
    return result;
  }

  if (input.mode === 'api_key_query') {
    const param = input.queryParamName.trim();
    if (!param) return { ...result, error: 'Query parameter name is required' };
    const slot = queryParamBindingSlot(param);
    const binding = bind(slot, input.primarySecretName, input.primarySecretValue);
    if (binding) result.queryParams[param] = binding;
    return result;
  }

  if (input.mode === 'basic') {
    if (!input.basicUsername.trim()) return { ...result, error: 'Basic auth username is required' };
    const passwordSlot = 'auth:basic:password';
    const password = bind(passwordSlot, input.basicPasswordSecretName, input.basicPasswordValue);
    if (password) {
      result.auth = {
        type: 'basic',
        username: input.basicUsername.trim(),
        password,
      };
    }
    return result;
  }

  if (input.mode === 'oauth2_client_credentials') {
    if (!input.oauthTokenUrl.trim()) return { ...result, error: 'OAuth token URL is required' };
    const clientId = bind('oauth2:client-credentials:client-id', input.oauthClientIdSecretName, input.oauthClientIdValue);
    const clientSecret = bind(
      'oauth2:client-credentials:client-secret',
      input.oauthClientSecretName,
      input.oauthClientSecretValue,
    );
    if (clientId && clientSecret) {
      result.auth = {
        type: 'oauth2_client_credentials',
        token_url: input.oauthTokenUrl.trim(),
        scopes: input.oauthScopes.trim(),
        client_id: clientId,
        client_secret: clientSecret,
      };
    }
    return result;
  }

  if (input.mode === 'custom') {
    for (const row of input.customHeaders) {
      const name = row.name.trim();
      if (!name) return { ...result, error: 'Every custom header needs a name' };
      const binding = bind(headerBindingSlot(name), row.secretName, row.value, row.prefix.trim() || undefined);
      if (binding) result.headers[name] = binding;
      if (result.error) return result;
    }
    for (const row of input.customQueryParams) {
      const name = row.name.trim();
      if (!name) return { ...result, error: 'Every custom query parameter needs a name' };
      const binding = bind(queryParamBindingSlot(name), row.secretName, row.value, row.prefix.trim() || undefined);
      if (binding) result.queryParams[name] = binding;
      if (result.error) return result;
    }
    if (input.customHeaders.length === 0 && input.customQueryParams.length === 0) {
      return { ...result, error: 'Add at least one custom header or query parameter' };
    }
  }

  return result;
}

function buildSourceConfig(input: {
  sourceType: ManualSourceType;
  name: string;
  namespace: string;
  endpoint: string;
  baseUrl: string;
  preset: PopularSourcePreset | null;
  credentials: CredentialBuildResult;
}) {
  const common = pruneUndefined({
    executor_source_schema: 'kortix.executor.source.v1',
    plugin_id: input.sourceType,
    display_name: input.name,
    namespace: input.namespace,
    credential_target_scope: 'project',
    credential_mode: input.credentials.mode,
    headers: input.credentials.headers,
    queryParams: input.credentials.queryParams,
    auth: input.credentials.auth,
    credential_bindings: input.credentials.credentialBindings,
    required_secret_names: input.credentials.requiredSecretNames,
    preset_id: input.preset?.id,
    preset_name: input.preset?.name,
  });

  if (input.sourceType === 'openapi') {
    return pruneUndefined({
      ...common,
      url: input.endpoint,
      spec_url: input.endpoint,
      base_url: input.baseUrl || input.preset?.baseUrl,
    });
  }

  if (input.sourceType === 'graphql') {
    return pruneUndefined({
      ...common,
      url: input.endpoint,
      endpoint: input.endpoint,
    });
  }

  return pruneUndefined({
    ...common,
    url: input.endpoint,
    transport: 'remote',
  });
}

function inputSchemaForSource(sourceType: ManualSourceType) {
  if (sourceType === 'graphql') {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GraphQL query or mutation document.' },
        variables: { type: 'object', description: 'GraphQL variables object.' },
        operationName: { type: 'string', description: 'Optional GraphQL operation name.' },
      },
      required: ['query'],
      additionalProperties: false,
    };
  }

  if (sourceType === 'mcp') {
    return {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'JSON-RPC method to call on the remote MCP server.' },
        params: { type: 'object', description: 'JSON-RPC params for the remote MCP call.' },
      },
      required: ['method'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {
      method: { type: 'string', description: 'HTTP method. Defaults to GET.' },
      path: { type: 'string', description: 'Relative REST path when base URL is configured.' },
      url: { type: 'string', description: 'Absolute URL to call. Overrides path/base URL.' },
      query: { type: 'object', description: 'Additional query parameters.' },
      headers: { type: 'object', description: 'Additional request headers.' },
      body: { description: 'JSON body for POST, PUT, PATCH, or DELETE requests.' },
    },
    additionalProperties: false,
  };
}

function implementationKindForSource(sourceType: ManualSourceType) {
  if (sourceType === 'graphql') return 'graphql_proxy';
  if (sourceType === 'mcp') return 'mcp_remote_proxy';
  return 'http_proxy';
}

function dedupeSecretWrites(writes: Array<{ name: string; value: string }>) {
  const byName = new Map<string, { name: string; value: string }>();
  for (const write of writes) byName.set(write.name, write);
  return Array.from(byName.values());
}

function createCredentialRow(label: string): CredentialRow {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    name: '',
    secretName: defaultSecretName(`EXECUTOR_${label}_SECRET`),
    value: '',
    prefix: '',
  };
}

function defaultCredentialModeForPreset(preset: PopularSourcePreset): CredentialMode {
  if (['petstore', 'anilist', 'deepwiki', 'context7'].includes(preset.id)) return 'none';
  return 'bearer';
}

function credentialModeLabel(mode: CredentialMode) {
  switch (mode) {
    case 'none':
      return 'No auth';
    case 'bearer':
      return 'Bearer token';
    case 'api_key_header':
      return 'API key header';
    case 'api_key_query':
      return 'API key query';
    case 'basic':
      return 'Basic auth';
    case 'custom':
      return 'Custom';
    case 'oauth2_client_credentials':
      return 'OAuth2 client credentials';
    default:
      return mode;
  }
}

function defaultHeaderNameForPreset(_preset: PopularSourcePreset, mode: CredentialMode) {
  return mode === 'api_key_header' ? 'X-API-Key' : 'Authorization';
}

function defaultQueryParamNameForPreset(_preset: PopularSourcePreset) {
  return 'api_key';
}

function defaultSecretSlotForMode(mode: CredentialMode) {
  if (mode === 'bearer') return 'BEARER_TOKEN';
  if (mode === 'api_key_header') return 'API_KEY';
  if (mode === 'api_key_query') return 'API_KEY';
  return 'CREDENTIAL';
}

function defaultSecretPrefix(name: string) {
  return `EXECUTOR_${name}`.replace(/[^a-zA-Z0-9_]+/g, '_');
}

function defaultSecretName(value: string) {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^KORTIX_/, 'EXECUTOR_');
  const withPrefix = /^[A-Z_]/.test(normalized) ? normalized : `EXECUTOR_${normalized}`;
  return withPrefix.slice(0, 64).replace(/_+$/g, '') || 'EXECUTOR_SECRET';
}

function normalizeSecretInput(value: string) {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z_][A-Z0-9_]{0,63}$/.test(normalized) && !normalized.startsWith('KORTIX_')
    ? normalized
    : null;
}

function normalizeNamespace(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'source';
}

function credentialSlotPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function headerBindingSlot(header: string) {
  return `header:${credentialSlotPart(header)}`;
}

function queryParamBindingSlot(param: string) {
  return `query_param:${credentialSlotPart(param)}`;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizePresetToolName(preset: PopularSourcePreset) {
  const suffix = preset.method === 'openapi'
    ? 'request'
    : preset.method === 'graphql'
      ? 'query'
      : 'tool';

  return `${preset.id}.${suffix}`
    .replace(/[^a-zA-Z0-9_.-]+/g, '.')
    .replace(/-+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase();
}
