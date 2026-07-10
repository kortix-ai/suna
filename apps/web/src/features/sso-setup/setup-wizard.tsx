'use client';

// Guided SSO setup — Vercel-style wizard. Screen 1 picks the identity
// provider; screen 2 walks the provider-specific steps (guides.ts) with a
// vertical stepper, copyable SP values, and an INLINE final import step that
// actually registers the IdP (no bouncing back to settings with values in a
// notepad). Step completion persists per account+provider in localStorage.

import { toast } from '@/lib/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Search,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { getEnv } from '@/lib/env-config';
import { getSsoProvider, importSsoProviderFromMetadata } from '@/lib/iam-client';
import { type SamlSpUrls, buildSamlSpUrls } from '@/lib/saml-sp';
import { PROVIDER_GUIDES, type GuideStep, getProviderGuide } from './guides';

function storageKey(accountId: string, provider: string) {
  return `kortix:sso-setup:${accountId}:${provider}`;
}

function loadCompleted(accountId: string, provider: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(accountId, provider));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function saveCompleted(accountId: string, provider: string, ids: string[]) {
  try {
    window.localStorage.setItem(storageKey(accountId, provider), JSON.stringify(ids));
  } catch {
    // Non-critical — the wizard still works, progress just isn't remembered.
  }
}

async function copyValue(value: string, msg: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(msg);
  } catch {
    toast.warning('Copy failed — select and copy manually');
  }
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
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function SpValueRows({ urls }: { urls: SamlSpUrls | null }) {
  if (!urls) return null;
  return (
    <div className="border-border/60 bg-card/50 space-y-3 rounded-lg border p-4">
      <CopyRow label="Identifier (Entity ID)" value={urls.entityId} />
      <CopyRow label="Reply URL (ACS)" value={urls.acsUrl} />
    </div>
  );
}

// ─── Screen 1: provider select ─────────────────────────────────────────────

function ProviderSelect({ onPick }: { onPick: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const guides = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PROVIDER_GUIDES;
    return PROVIDER_GUIDES.filter((g) => `${g.name} ${g.blurb}`.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="mx-auto w-full max-w-xl">
      <h1 className="text-foreground text-center text-2xl font-semibold">
        Select your identity provider
      </h1>
      <div className="border-border/70 bg-card mt-8 overflow-hidden rounded-xl border">
        <div className="border-border/60 relative border-b">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2" />
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
            className="border-border/40 hover:bg-muted/40 flex w-full items-center justify-between gap-3 border-b px-5 py-4 text-left last:border-b-0"
          >
            <span className="min-w-0">
              <span className="text-foreground block text-sm font-medium">{g.name}</span>
              <span className="text-muted-foreground block truncate text-xs">{g.blurb}</span>
            </span>
            <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
          </button>
        ))}
        {guides.length === 0 && (
          <p className="text-muted-foreground px-5 py-6 text-sm">
            No match — pick Custom SAML for any SAML 2.0 identity provider.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Screen 2: the guide ───────────────────────────────────────────────────

function ImportForm({
  accountId,
  providerName,
  defaultClaim,
  alreadyConnected,
  onDone,
}: {
  accountId: string;
  providerName: string;
  defaultClaim: string;
  alreadyConnected: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(providerName);
  const [domain, setDomain] = useState('');
  const [claim, setClaim] = useState(defaultClaim);
  const [autoCreate, setAutoCreate] = useState(true);
  const [autoProvision, setAutoProvision] = useState(false);
  const [metaKind, setMetaKind] = useState<'url' | 'xml'>('url');
  const [metaUrl, setMetaUrl] = useState('');
  const [metaXml, setMetaXml] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      importSsoProviderFromMetadata(accountId, {
        name: name.trim(),
        primary_domain: domain.trim().toLowerCase(),
        group_claim_name: claim.trim() || defaultClaim,
        auto_create_members: autoCreate,
        auto_provision_groups: autoProvision,
        ...(metaKind === 'xml' ? { metadata_xml: metaXml.trim() } : { metadata_url: metaUrl.trim() }),
      }),
    onSuccess: () => {
      toast.success('Identity provider connected');
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
      onDone();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to connect the provider'),
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
                    ? 'bg-secondary text-foreground px-2.5 py-1 text-[11px] font-medium'
                    : 'text-muted-foreground hover:bg-muted/50 px-2.5 py-1 text-[11px]'
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
            placeholder="https://…/federationmetadata.xml"
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
            className="border-border bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 font-mono text-[11px] outline-none focus-visible:ring-1"
          />
        )}
      </div>

      <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoCreate}
          onChange={(e) => setAutoCreate(e.target.checked)}
          className="border-border accent-primary mt-0.5 h-3.5 w-3.5 rounded"
          disabled={mutation.isPending}
        />
        <span>
          <span className="font-medium">Auto-create members</span>
          <span className="text-muted-foreground block text-[11px]">
            Anyone who signs in via SSO from your domain becomes a member automatically.
          </span>
        </span>
      </label>
      <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoProvision}
          onChange={(e) => setAutoProvision(e.target.checked)}
          className="border-border accent-primary mt-0.5 h-3.5 w-3.5 rounded"
          disabled={mutation.isPending}
        />
        <span>
          <span className="font-medium">Auto-provision groups</span>
          <span className="text-muted-foreground block text-[11px]">
            Create a Kortix group for every group your IdP sends — no per-group mapping.
          </span>
        </span>
      </label>

      <Button onClick={() => mutation.mutate()} disabled={!ready || mutation.isPending}>
        {mutation.isPending ? 'Connecting…' : 'Connect provider'}
      </Button>
    </div>
  );
}

function StepBody({
  step,
  spUrls,
  accountId,
  providerName,
  defaultClaim,
  alreadyConnected,
  onCompleteStep,
  onFinish,
}: {
  step: GuideStep;
  spUrls: SamlSpUrls | null;
  accountId: string;
  providerName: string;
  defaultClaim: string;
  alreadyConnected: boolean;
  onCompleteStep: () => void;
  onFinish: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">{step.intro}</p>

      {step.bullets && (
        <ol className="text-foreground list-decimal space-y-1.5 pl-5 text-sm">
          {step.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ol>
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
          defaultClaim={defaultClaim}
          alreadyConnected={alreadyConnected}
          onDone={onCompleteStep}
        />
      ) : step.kind === 'test' ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline">
            <a href="/auth" target="_blank" rel="noreferrer">
              Open the sign-in page
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </a>
          </Button>
          <Button onClick={onFinish}>
            Finish
            <Check className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <Button onClick={onCompleteStep}>
          I’ve completed this step
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ─── The wizard ────────────────────────────────────────────────────────────

export function SsoSetupWizard({ accountId }: { accountId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const providerId = searchParams?.get('provider') ?? null;
  const guide = getProviderGuide(providerId);

  const accountStateQuery = useAccountState({ accountId, enabled: !!accountId });
  const entitlements = accountStateQuery.data?.tier?.entitlements;
  const ssoEntitled = !!entitlements?.sso;

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
    const done = loadCompleted(accountId, guide.id);
    setCompleted(done);
    const firstOpen = guide.steps.findIndex((s) => !done.includes(s.id));
    setActiveStep(firstOpen === -1 ? guide.steps.length - 1 : firstOpen);
  }, [accountId, guide]);

  if (accountStateQuery.isLoading) {
    return <Skeleton className="mx-auto h-96 w-full max-w-3xl rounded-2xl" />;
  }
  if (!ssoEntitled) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <EnterpriseUpsell feature="identity" />
      </div>
    );
  }

  if (!guide) {
    return (
      <ProviderSelect
        onPick={(id) => router.replace(`/accounts/${accountId}/sso-setup?provider=${id}`)}
      />
    );
  }

  const markDone = (stepId: string) => {
    const next = completed.includes(stepId) ? completed : [...completed, stepId];
    setCompleted(next);
    saveCompleted(accountId, guide.id, next);
    const idx = guide.steps.findIndex((s) => s.id === stepId);
    if (idx >= 0 && idx < guide.steps.length - 1) setActiveStep(idx + 1);
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
          <ShieldCheck className="text-muted-foreground h-4 w-4" />
          <span className="text-foreground text-sm font-medium">{guide.name}</span>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/accounts/${accountId}/sso-setup`}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Change provider
          </Link>
        </Button>
      </div>

      <div className="grid gap-10 md:grid-cols-[240px_minmax(0,1fr)]">
        <Stepper
          orientation="vertical"
          value={activeStep}
          onValueChange={setActiveStep}
          count={guide.steps.length - 1}
          className="gap-0"
        >
          {guide.steps.map((s, i) => (
            <StepperItem key={s.id} step={i} completed={completed.includes(s.id)} className="items-start">
              <div className="flex flex-col items-center self-stretch">
                <StepperTrigger>
                  <StepperIndicator>
                    {completed.includes(s.id) ? <Check className="h-3 w-3" /> : i + 1}
                  </StepperIndicator>
                </StepperTrigger>
                <StepperSeparator />
              </div>
              <StepperTrigger className="ml-3 pb-6">
                <StepperTitle
                  className={
                    i === activeStep ? 'text-foreground text-left' : 'text-muted-foreground text-left'
                  }
                >
                  {s.title}
                </StepperTitle>
              </StepperTrigger>
            </StepperItem>
          ))}
        </Stepper>

        <div className="min-w-0">
          <h2 className="text-foreground text-xl font-semibold">
            Step {activeStep + 1}: {step.title}
          </h2>
          <div className="mt-4">
            <StepBody
              step={step}
              spUrls={spUrls}
              accountId={accountId}
              providerName={guide.name}
              defaultClaim={guide.defaultGroupClaim}
              alreadyConnected={!!providerQuery.data}
              onCompleteStep={() => markDone(step.id)}
              onFinish={finish}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
