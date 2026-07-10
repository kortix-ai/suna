'use client';

// Guided identity setup — Vercel-style wizards for SAML SSO and Directory
// Sync (SCIM). Screen 1 picks the identity provider; screen 2 walks the
// provider-specific steps (guides.ts) with a vertical stepper, copyable
// values, and INLINE pivotal steps: SSO imports the IdP metadata right in the
// wizard, Directory Sync mints the SCIM bearer token right in the wizard —
// no bouncing to settings with values in a notepad. Step completion persists
// per account+flow+provider in localStorage.

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  RotateCcw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { cn } from '@/lib/utils';
import { getEnv } from '@/lib/env-config';
import {
  type CreatedScimToken,
  createScimToken,
  getSsoProvider,
  importSsoProviderFromMetadata,
} from '@/lib/iam-client';
import { type SamlSpUrls, buildSamlSpUrls } from '@/lib/saml-sp';
import { buildScimBaseUrl } from '@/lib/scim-url';
import {
  type GuideStep,
  type ProviderConfig,
  type ProviderGuide,
  PROVIDER_GUIDES,
  SCIM_PROVIDER_GUIDES,
  getProviderGuide,
  getScimGuide,
} from './guides';

// Monochrome brand marks (same currentColor + dark:invert technique as the
// LLM provider pickers — see features/providers/provider-branding.tsx). The
// dedicated google-workspace mark exists because provider-icons/google.svg is
// the Gemini star, not the Workspace G.
const PROVIDER_ICONS: Record<ProviderGuide['id'], string> = {
  entra: '/provider-icons/azure.svg',
  okta: '/provider-icons/okta.svg',
  google: '/provider-icons/google-workspace.svg',
  custom: '/provider-icons/generic-provider.svg',
};

type Flow = 'sso' | 'scim';

const FLOW_CONFIG: Record<
  Flow,
  { route: string; heading: string; subheading: string; entitlement: 'sso' | 'scim' }
> = {
  sso: {
    route: 'sso-setup',
    heading: 'Select your identity provider',
    subheading: 'Let your team sign in with the identity provider you already run.',
    entitlement: 'sso',
  },
  scim: {
    route: 'scim-setup',
    heading: 'Set up Directory Sync',
    subheading: 'Provision and deprovision accounts automatically from your identity provider.',
    entitlement: 'scim',
  },
};

// Explicit literals (not a template) so the keys stay greppable.
function storageKey(flow: Flow, accountId: string, provider: string) {
  const prefix = flow === 'sso' ? 'kortix:sso-setup' : 'kortix:scim-setup';
  return `${prefix}:${accountId}:${provider}`;
}

function loadCompleted(flow: Flow, accountId: string, provider: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(flow, accountId, provider));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function saveCompleted(flow: Flow, accountId: string, provider: string, ids: string[]) {
  try {
    window.localStorage.setItem(storageKey(flow, accountId, provider), JSON.stringify(ids));
  } catch {
    // Non-critical — the wizard still works, progress just isn't remembered.
  }
}

async function copyValue(value: string, msg: string) {
  try {
    await navigator.clipboard.writeText(value);
    successToast(msg);
  } catch {
    warningToast('Copy failed — select and copy manually');
  }
}

/**
 * Instruction text with the quoted IdP-console labels ("Basic SAML
 * Configuration", "Create your own application") rendered as code chips —
 * the admin scans for exactly those strings in the other tab.
 */
function InstructionText({ text }: { text: string }) {
  const parts = text.split(/"([^"]+)"/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            // biome-ignore lint/suspicious/noArrayIndexKey: static text, stable order
            key={i}
            className="bg-muted/60 text-foreground rounded px-1 py-0.5 font-mono text-xs"
          >
            {part}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, stable order
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * Console screenshot for a guide step. Hides itself until the asset exists
 * (guides can declare image blocks before the capture run lands the PNGs) —
 * a broken-image frame would read as a bug.
 */
function GuideImage({ src, alt }: { src: string; alt: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setMissing(true)}
      className="border-border/60 w-full rounded-md border"
    />
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <code className="border-border/60 bg-muted/30 min-w-0 flex-1 truncate rounded border px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <Button
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={() => copyValue(value, `${label} copied`)}
        >
          <Copy className="size-3.5 shrink-0" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Claim-mapping table (Vercel layout): Name (+Required) → Source Attribute,
 * copy buttons on both sides so the admin never types an attribute path.
 */
function ClaimsTable({
  rows,
}: {
  rows: Array<{ name: string; source: string; required?: boolean }>;
}) {
  return (
    <div className="border-border/60 bg-popover overflow-hidden rounded-md border">
      <div className="border-border/40 text-muted-foreground grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b px-4 py-2 text-xs font-medium">
        <span>Name</span>
        <span>Source attribute</span>
      </div>
      <ul className="divide-border/40 divide-y">
        {rows.map((row) => (
          <li
            key={row.name}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 px-4 py-2"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <code className="text-foreground truncate font-mono text-xs">{row.name}</code>
              {row.required && (
                <Badge variant="outline" size="xs" className="shrink-0">
                  Required
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`Copy claim name ${row.name}`}
                onClick={() => copyValue(row.name, 'Claim name copied')}
              >
                <Copy className="size-3" />
              </Button>
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <ArrowRight className="text-muted-foreground/60 size-3 shrink-0" />
              <code className="text-foreground truncate font-mono text-xs">{row.source}</code>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`Copy source attribute ${row.source}`}
                onClick={() => copyValue(row.source, 'Source attribute copied')}
              >
                <Copy className="size-3" />
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SpValueRows({ urls }: { urls: SamlSpUrls | null }) {
  if (!urls) return null;
  return (
    <div className="border-border/60 bg-popover space-y-3 rounded-md border p-4">
      <CopyRow label="Identifier (Entity ID)" value={urls.entityId} />
      <CopyRow label="Reply URL (ACS)" value={urls.acsUrl} />
    </div>
  );
}

// ─── Screen 1: provider select ─────────────────────────────────────────────

function ProviderSelect({
  flow,
  accountId,
  ssoConnected,
  onPick,
}: {
  flow: Flow;
  accountId: string;
  ssoConnected: boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const all = flow === 'sso' ? PROVIDER_GUIDES : SCIM_PROVIDER_GUIDES;
  const guides = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((g) => `${g.name} ${g.blurb}`.toLowerCase().includes(q));
  }, [all, query]);

  return (
    <div className="mx-auto w-full max-w-xl">
      <h1 className="text-foreground text-center text-2xl font-semibold">
        {FLOW_CONFIG[flow].heading}
      </h1>
      <p className="text-muted-foreground mt-2 text-center text-sm">
        {FLOW_CONFIG[flow].subheading}
      </p>
      {flow === 'scim' && !ssoConnected && (
        <div className="mt-6">
          <InfoBanner
            tone="info"
            title="Set up SAML SSO first"
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={`/accounts/${accountId}/sso-setup`}>Set up SSO</Link>
              </Button>
            }
          >
            Directory Sync provisions accounts, but without SSO those users have no way to sign
            in. Connecting SAML first is strongly recommended.
          </InfoBanner>
        </div>
      )}
      <div className="border-border/70 bg-card mt-8 overflow-hidden rounded-md border">
        <div className="border-border/60 relative border-b">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find your provider"
            className="h-12 rounded-none border-0 pl-11 shadow-none focus-visible:ring-0"
          />
        </div>
        {guides.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onPick(g.id)}
            className="group border-border/40 hover:bg-muted/40 flex w-full items-center gap-3.5 border-b px-4 py-3.5 text-left transition-colors last:border-b-0"
          >
            <span className="border-border/60 bg-background flex size-10 shrink-0 items-center justify-center rounded-md border">
              <Image
                src={PROVIDER_ICONS[g.id]}
                alt=""
                width={20}
                height={20}
                className="object-contain dark:invert"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-sm font-medium">{g.name}</span>
              <span className="text-muted-foreground block truncate text-xs">{g.blurb}</span>
            </span>
            <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
        {guides.length === 0 && (
          <p className="text-muted-foreground px-5 py-6 text-sm">
            No match — pick the Custom option for any standards-based provider.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── SSO: inline metadata import ───────────────────────────────────────────

function ImportForm({
  accountId,
  providerName,
  config,
  alreadyConnected,
  onDone,
}: {
  accountId: string;
  providerName: string;
  config: ProviderConfig;
  alreadyConnected: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(providerName);
  const [domain, setDomain] = useState('');
  const [claim, setClaim] = useState(config.groupClaimName);
  const [autoCreate, setAutoCreate] = useState(true);
  const [autoProvision, setAutoProvision] = useState(false);
  // Default to the form this IdP actually hands out (Google: XML only).
  const [metaKind, setMetaKind] = useState<'url' | 'xml'>(config.preferredMetadata ?? 'url');
  const [metaUrl, setMetaUrl] = useState('');
  const [metaXml, setMetaXml] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      importSsoProviderFromMetadata(accountId, {
        name: name.trim(),
        primary_domain: domain.trim().toLowerCase(),
        group_claim_name: claim.trim() || config.groupClaimName,
        auto_create_members: autoCreate,
        auto_provision_groups: autoProvision,
        ...(metaKind === 'xml' ? { metadata_xml: metaXml.trim() } : { metadata_url: metaUrl.trim() }),
      }),
    onSuccess: () => {
      successToast('Identity provider connected');
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
      onDone();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to connect the provider'),
  });

  const metadataReady =
    metaKind === 'xml' ? metaXml.trim().length > 40 : /^https?:\/\/.+/i.test(metaUrl.trim());
  const ready =
    name.trim().length > 0 && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()) && metadataReady;

  if (alreadyConnected) {
    return (
      <InfoBanner tone="info" title="Already connected">
        This account already has an SSO provider. Manage it from the SAML SSO card in account
        settings — remove it there first to run a fresh import.
      </InfoBanner>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Display name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={mutation.isPending} />
        </div>
        <div className="space-y-1.5">
          <Label>Primary email domain</Label>
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.com"
            disabled={mutation.isPending}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Group claim name</Label>
        <Input
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          className="font-mono text-xs"
          disabled={mutation.isPending}
        />
        {/* Per-provider truth about the VALUES inside the claim — Entra sends
            GUIDs, Okta/Google send names — so admins map the right thing. */}
        <p className="text-muted-foreground text-xs">{config.groupValueHint}</p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Federation metadata</Label>
          <div className="border-border/70 inline-flex overflow-hidden rounded-md border">
            {(
              [
                ['url', 'From URL'],
                ['xml', 'Paste XML'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setMetaKind(k)}
                disabled={mutation.isPending}
                className={
                  metaKind === k
                    ? 'bg-secondary text-foreground px-2.5 py-1 text-xs font-medium'
                    : 'text-muted-foreground hover:bg-muted/50 px-2.5 py-1 text-xs'
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {metaKind === 'url' ? (
          <Input
            value={metaUrl}
            onChange={(e) => setMetaUrl(e.target.value)}
            placeholder={config.metadataUrlPlaceholder ?? 'https://…/saml/metadata.xml'}
            className="text-xs"
            disabled={mutation.isPending}
          />
        ) : (
          <textarea
            value={metaXml}
            onChange={(e) => setMetaXml(e.target.value)}
            placeholder="<EntityDescriptor …>…</EntityDescriptor>"
            disabled={mutation.isPending}
            rows={5}
            className="border-border bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1"
          />
        )}
      </div>

      <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoCreate}
          onChange={(e) => setAutoCreate(e.target.checked)}
          className="border-border accent-primary mt-0.5 size-3.5 shrink-0 rounded"
          disabled={mutation.isPending}
        />
        <span>
          <span className="font-medium">Auto-create members</span>
          <span className="text-muted-foreground block text-xs">
            Anyone who signs in via SSO from your domain becomes a member automatically.
          </span>
        </span>
      </label>
      <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoProvision}
          onChange={(e) => setAutoProvision(e.target.checked)}
          className="border-border accent-primary mt-0.5 size-3.5 shrink-0 rounded"
          disabled={mutation.isPending}
        />
        <span>
          <span className="font-medium">Auto-provision groups</span>
          <span className="text-muted-foreground block text-xs">
            Create a Kortix group for every group your IdP sends — no per-group mapping.
          </span>
        </span>
      </label>

      <Button
        onClick={() => mutation.mutate()}
        disabled={!ready || mutation.isPending}
        className="gap-1.5"
      >
        {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
        Connect provider
      </Button>
    </div>
  );
}

// ─── Directory Sync: inline token mint ─────────────────────────────────────

function ScimTokenStep({
  accountId,
  providerName,
  onDone,
}: {
  accountId: string;
  providerName: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(`${providerName} provisioning`);
  const [minted, setMinted] = useState<CreatedScimToken | null>(null);
  const tenantUrl = useMemo(
    () => buildScimBaseUrl(accountId, getEnv().BACKEND_URL),
    [accountId],
  );

  const mutation = useMutation({
    mutationFn: () => createScimToken(accountId, { name: name.trim() }),
    onSuccess: (token) => {
      setMinted(token);
      successToast('SCIM token minted — copy it now');
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to mint the token'),
  });

  return (
    <div className="space-y-4">
      <div className="border-border/60 bg-popover space-y-3 rounded-md border p-4">
        <CopyRow label="Tenant URL" value={tenantUrl} />
        <p className="text-muted-foreground text-xs">
          Your identity provider appends /Users and /Groups to this URL.
        </p>
      </div>

      {minted ? (
        <div className="border-border/60 bg-popover space-y-3 rounded-md border p-4">
          <CopyRow label="Secret token" value={minted.secret} />
          <p className="text-kortix-orange text-xs">
            Shown once — after you leave this step only the prefix ({minted.public_prefix}) is
            visible. Manage or revoke it from the SCIM card in settings.
          </p>
          <Button onClick={onDone}>
            I’ve copied both values
            <ArrowRight className="ml-1.5 size-3.5 shrink-0" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 space-y-1.5">
            <Label>Token name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={mutation.isPending} />
          </div>
          <Button
            onClick={() => mutation.mutate()}
            disabled={name.trim().length === 0 || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <KeyRound className="size-3.5 shrink-0" />
            )}
            Mint token
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Step body ───────────────────────────────────────────────────────────────

function StepBody({
  flow,
  step,
  spUrls,
  accountId,
  providerName,
  config,
  alreadyConnected,
  onCompleteStep,
  onFinish,
}: {
  flow: Flow;
  step: GuideStep;
  spUrls: SamlSpUrls | null;
  accountId: string;
  providerName: string;
  config: ProviderConfig;
  alreadyConnected: boolean;
  onCompleteStep: () => void;
  onFinish: () => void;
}) {
  // The test step's bullets are a verification CHECKLIST (unordered outcomes);
  // every other step's bullets are a numbered sequence of console actions.
  const isChecklist = step.kind === 'test';

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        <InstructionText text={step.intro} />
      </p>

      {step.content?.map((block, i) =>
        block.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static guide data, stable order
          <p key={i} className="text-foreground text-sm leading-relaxed">
            <InstructionText text={block.text} />
          </p>
        ) : block.kind === 'sp-values' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static guide data, stable order
          <SpValueRows key={i} urls={spUrls} />
        ) : block.kind === 'claims-table' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static guide data, stable order
          <ClaimsTable key={i} rows={block.rows} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static guide data, stable order
          <GuideImage key={i} src={block.src} alt={block.alt} />
        ),
      )}

      {step.bullets && (
        <ol className="space-y-2.5">
          {step.bullets.map((b, n) => (
            <li key={b} className="flex items-start gap-3">
              <span className="bg-muted text-muted-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums">
                {isChecklist ? <Check className="size-3" /> : n + 1}
              </span>
              <span className="text-foreground min-w-0 text-sm leading-relaxed">
                <InstructionText text={b} />
              </span>
            </li>
          ))}
        </ol>
      )}

      {step.image && (
        // Our own IdP-console captures (public/sso-setup/<provider>/) — plain
        // <img> like other static assets; screenshots keep their light chrome
        // in both themes.
        <img
          src={step.image.src}
          alt={step.image.alt}
          loading="lazy"
          className="border-border/60 w-full rounded-md border"
        />
      )}

      {step.showSpValues && <SpValueRows urls={spUrls} />}

      {step.warning && (
        <InfoBanner tone="warning" title="Watch out">
          {step.warning}
        </InfoBanner>
      )}

      {step.note && <p className="text-muted-foreground text-xs">{step.note}</p>}

      {step.kind === 'import' ? (
        <ImportForm
          accountId={accountId}
          providerName={providerName}
          config={config}
          alreadyConnected={alreadyConnected}
          onDone={onCompleteStep}
        />
      ) : step.kind === 'scim-token' ? (
        <ScimTokenStep accountId={accountId} providerName={providerName} onDone={onCompleteStep} />
      ) : step.kind === 'test' ? (
        <div className="flex flex-wrap items-center gap-3">
          {flow === 'sso' && (
            <Button asChild variant="outline">
              <a href="/auth" target="_blank" rel="noreferrer">
                Open the sign-in page
                <ExternalLink className="ml-1.5 size-3.5 shrink-0" />
              </a>
            </Button>
          )}
          <Button onClick={onFinish}>
            Finish
            <Check className="ml-1.5 size-3.5 shrink-0" />
          </Button>
        </div>
      ) : (
        // Vercel-style completion bar: the step's outcome as a checkable
        // statement + Continue.
        <div className="border-border/70 bg-popover flex items-center justify-between gap-3 rounded-md border py-3 pr-3 pl-4">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="bg-kortix-green/15 flex size-6 shrink-0 items-center justify-center rounded-full">
              <Check className="text-kortix-green size-3.5" />
            </span>
            <span className="text-foreground truncate text-sm">
              {step.doneLabel ?? 'I’ve completed this step'}
            </span>
          </span>
          <Button onClick={onCompleteStep} className="shrink-0 gap-1.5">
            Continue
            <ArrowRight className="size-3.5 shrink-0" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── The wizard ────────────────────────────────────────────────────────────

function WizardCore({ accountId, flow }: { accountId: string; flow: Flow }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const providerId = searchParams?.get('provider') ?? null;
  const guide = flow === 'sso' ? getProviderGuide(providerId) : getScimGuide(providerId);
  const config = FLOW_CONFIG[flow];

  const accountStateQuery = useAccountState({ accountId, enabled: !!accountId });
  const entitlements = accountStateQuery.data?.tier?.entitlements;
  const entitled = !!entitlements?.[config.entitlement];

  const providerQuery = useQuery({
    queryKey: ['iam-sso-provider', accountId],
    queryFn: () => getSsoProvider(accountId),
    staleTime: 30_000,
  });

  const spUrls = useMemo(() => buildSamlSpUrls(getEnv().SUPABASE_URL), []);

  const [activeStep, setActiveStep] = useState(0);
  const [completed, setCompleted] = useState<string[]>([]);

  // Restore progress when a guide opens; jump to the first incomplete step.
  useEffect(() => {
    if (!guide) return;
    const done = loadCompleted(flow, accountId, guide.id);
    setCompleted(done);
    const firstOpen = guide.steps.findIndex((s) => !done.includes(s.id));
    setActiveStep(firstOpen === -1 ? guide.steps.length - 1 : firstOpen);
  }, [accountId, flow, guide]);

  if (accountStateQuery.isLoading) {
    return <Skeleton className="mx-auto h-96 w-full max-w-3xl rounded-md" />;
  }
  if (!entitled) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <EnterpriseUpsell feature="identity" />
      </div>
    );
  }

  if (!guide) {
    return (
      <ProviderSelect
        flow={flow}
        accountId={accountId}
        ssoConnected={!!providerQuery.data}
        onPick={(id) => router.replace(`/accounts/${accountId}/${config.route}?provider=${id}`)}
      />
    );
  }

  const markDone = (stepId: string) => {
    const next = completed.includes(stepId) ? completed : [...completed, stepId];
    setCompleted(next);
    saveCompleted(flow, accountId, guide.id, next);
    const idx = guide.steps.findIndex((s) => s.id === stepId);
    if (idx >= 0 && idx < guide.steps.length - 1) setActiveStep(idx + 1);
  };

  const startOver = () => {
    setCompleted([]);
    saveCompleted(flow, accountId, guide.id, []);
    setActiveStep(0);
  };

  const finish = () => {
    markDone(guide.steps[guide.steps.length - 1]!.id);
    router.push(`/accounts/${accountId}?tab=settings`);
  };

  const step = guide.steps[Math.min(activeStep, guide.steps.length - 1)]!;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-8 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-muted-foreground size-4" />
          <span className="text-foreground text-sm font-medium">{guide.name}</span>
          <span className="text-muted-foreground text-xs">
            · {flow === 'sso' ? 'SAML SSO' : 'Directory Sync'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={startOver} className="gap-1.5">
            <RotateCcw className="size-3.5 shrink-0" />
            Start over
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/accounts/${accountId}/${config.route}`}>
              <ArrowLeft className="mr-1.5 size-3.5 shrink-0" />
              Change provider
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-10 md:grid-cols-[240px_minmax(0,1fr)]">
        {/* Vercel-style rail: no connector line — soft-green done circles,
            solid active circle, muted upcoming. Whole row is the target. */}
        <nav aria-label="Setup steps" className="space-y-1 self-start">
          {guide.steps.map((s, i) => {
            const isDone = completed.includes(s.id);
            const isActive = i === activeStep;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveStep(i)}
                aria-current={isActive ? 'step' : undefined}
                className="group hover:bg-muted/40 flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors"
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums transition-colors',
                    isDone
                      ? 'bg-kortix-green/15 text-kortix-green'
                      : isActive
                        ? 'bg-foreground text-background'
                        : 'bg-muted text-muted-foreground',
                  )}
                >
                  {isDone ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span
                  className={cn(
                    'min-w-0 truncate text-sm transition-colors',
                    isActive
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground group-hover:text-foreground',
                  )}
                >
                  {s.title}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Step {activeStep + 1} of {guide.steps.length}
          </p>
          <h2 className="text-foreground mt-1 text-xl font-semibold">{step.title}</h2>
          <div className="mt-4">
            <StepBody
              flow={flow}
              step={step}
              spUrls={spUrls}
              accountId={accountId}
              providerName={guide.name}
              config={guide.config}
              alreadyConnected={!!providerQuery.data}
              onCompleteStep={() => markDone(step.id)}
              onFinish={finish}
            />
          </div>
          <div className="border-border/40 mt-8 flex items-center justify-between gap-3 border-t pt-4">
            {activeStep > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setActiveStep(activeStep - 1)}
              >
                <ArrowLeft className="size-3.5 shrink-0" />
                Back
              </Button>
            ) : (
              <span />
            )}
            <span className="text-muted-foreground text-xs">
              {activeStep < guide.steps.length - 1
                ? `Next: ${guide.steps[activeStep + 1]!.title}`
                : 'Last step'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SsoSetupWizard({ accountId }: { accountId: string }) {
  return <WizardCore accountId={accountId} flow="sso" />;
}

export function ScimSetupWizard({ accountId }: { accountId: string }) {
  return <WizardCore accountId={accountId} flow="scim" />;
}
