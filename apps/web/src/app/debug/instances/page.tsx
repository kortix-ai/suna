'use client';

/**
 * /debug/instances
 *
 * Visual harness for every empty / filled / error state of the
 * /instances listing page, plus the backups page empty state.
 * Renders each variant in the real page chrome (top bar + centered
 * main column) so it looks exactly like production.
 *
 * Not linked from anywhere — just open /debug/instances.
 */

import { useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { AlertCircle, Archive, HardDrive, Loader2, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import type { SandboxInfo } from '@/lib/platform-client';
import type { ServerEntry } from '@/stores/server-store';

import {
  ComputerHeroCard,
  InstancesTopBar,
} from '@/app/instances/_components/shared';
import {
  FallbackInstanceCard,
  InstanceCard,
} from '@/app/instances/_components/instance-card';

// ─── Mock data ─────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: 'debug-user',
  app_metadata: {},
  user_metadata: { name: 'Debug User', avatar_url: undefined },
  aud: 'authenticated',
  created_at: new Date().toISOString(),
  email: 'debug@kortix.dev',
} as unknown as User;

function mockSandbox(overrides: Partial<SandboxInfo>): SandboxInfo {
  return {
    sandbox_id: 'sandbox-debug-0001',
    name: 'Debug Sandbox',
    status: 'active',
    provider: 'justavps',
    url: 'https://example.com',
    version: '1.4.2',
    metadata: { location: 'fsn1', serverType: 'cpx21' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as SandboxInfo;
}

const MOCK_SANDBOXES_VARIETY: SandboxInfo[] = [
  mockSandbox({
    sandbox_id: 'sb-alpha',
    name: 'alpha',
    status: 'active',
    metadata: { location: 'fsn1', serverType: 'cpx21' },
  }),
  mockSandbox({
    sandbox_id: 'sb-beta',
    name: 'beta',
    status: 'provisioning',
    metadata: { location: 'us-east' },
  }),
  mockSandbox({
    sandbox_id: 'sb-gamma',
    name: 'gamma-dev',
    status: 'stopped',
    metadata: {},
    version: undefined,
  }),
  mockSandbox({
    sandbox_id: 'sb-delta',
    name: 'delta',
    status: 'error',
    metadata: { location: 'hil', serverType: 'cpx31' },
  }),
];

const MOCK_FALLBACK_SERVERS: ServerEntry[] = [
  {
    id: 'fb-1',
    label: 'Home server',
    url: 'https://home.example.com',
    instanceId: 'inst-home-01',
  },
  {
    id: 'fb-2',
    label: 'Lab workstation',
    url: 'http://localhost:8008',
    instanceId: 'inst-lab-02',
  },
] as ServerEntry[];

// ─── Variants ──────────────────────────────────────────────────────────────

type Variant =
  | 'empty-get-started'
  | 'empty-claim-with-credits'
  | 'empty-claim-no-credits'
  | 'list-single'
  | 'list-variety'
  | 'list-provisioning'
  | 'fallback-list'
  | 'error'
  | 'loading'
  | 'backups-empty';

const VARIANTS: { id: Variant; label: string; group: string }[] = [
  { group: 'Empty states', id: 'empty-get-started', label: 'Get Started (new user)' },
  { group: 'Empty states', id: 'empty-claim-with-credits', label: 'Claim Computer (with credits)' },
  { group: 'Empty states', id: 'empty-claim-no-credits', label: 'Claim Computer (no credits)' },

  { group: 'Instance list', id: 'list-single', label: 'Single instance' },
  { group: 'Instance list', id: 'list-variety', label: 'Variety (all statuses)' },
  { group: 'Instance list', id: 'list-provisioning', label: 'One provisioning (animated)' },
  { group: 'Instance list', id: 'fallback-list', label: 'Fallback server list' },

  { group: 'Error / loading', id: 'error', label: 'Failed to load' },
  { group: 'Error / loading', id: 'loading', label: 'Connecting screen (routing)' },

  { group: 'Backups', id: 'backups-empty', label: 'Backups — empty' },
];

// ─── Page ──────────────────────────────────────────────────────────────────

export default function DebugInstancesPage() {
  const [variant, setVariant] = useState<Variant>('empty-get-started');
  const groups = Array.from(new Set(VARIANTS.map((v) => v.group)));

  return (
    <>
      {variant === 'loading' ? (
        <ConnectingScreen forceConnecting overrideStage="routing" />
      ) : (
        <InstancesPageShell>{renderVariant(variant)}</InstancesPageShell>
      )}

      {/* Floating control panel (same visual pattern as /debug/connecting) */}
      <div className="pointer-events-auto fixed right-5 top-5 z-[100] w-[280px] overflow-hidden rounded-2xl border border-border/50 bg-background/95 shadow-2xl shadow-black/20 backdrop-blur-xl">
        <div className="border-b border-border/40 px-4 py-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
            Instances page
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-foreground">
            Debug harness
          </p>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-2">
          {groups.map((group) => (
            <div key={group} className="mb-2 last:mb-0">
              <p className="px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/45">
                {group}
              </p>
              {VARIANTS.filter((v) => v.group === group).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariant(v.id)}
                  className={
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ' +
                    (variant === v.id
                      ? 'bg-foreground/[0.06] text-foreground'
                      : 'text-muted-foreground/70 hover:bg-foreground/[0.03] hover:text-foreground/90')
                  }
                >
                  <span
                    className={
                      'h-1.5 w-1.5 flex-shrink-0 rounded-full transition-colors ' +
                      (variant === v.id ? 'bg-foreground/80' : 'bg-foreground/15')
                    }
                  />
                  <span className="truncate">{v.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="border-t border-border/40 px-4 py-3">
          <p className="text-[10px] leading-relaxed text-muted-foreground/50">
            Not linked from the app. Visit{' '}
            <code className="rounded bg-foreground/[0.06] px-1 font-mono text-[10px]">
              /debug/instances
            </code>{' '}
            any time.
          </p>
        </div>
      </div>
    </>
  );
}

// ─── Page shell — matches /instances layout exactly ───────────────────────

function InstancesPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <InstancesTopBar user={MOCK_USER} />
      <main className="flex-1 flex items-start justify-center px-4 pt-12 pb-20">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  );
}

// ─── Variant renderers ────────────────────────────────────────────────────

function Header({ count, showNewButton }: { count?: number; showNewButton?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-xl font-semibold text-foreground">Instances</h1>
        {count !== undefined && count > 0 && (
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </div>
      {showNewButton && (
        <Button size="sm" className="gap-1.5" onClick={() => {}}>
          <Plus className="h-3.5 w-3.5" />
          New Instance
        </Button>
      )}
    </div>
  );
}

function renderVariant(variant: Variant): React.ReactNode {
  switch (variant) {
    case 'empty-get-started':
      return (
        <>
          <Header />
          <ComputerHeroCard
            title="Get Your Cloud Computer"
            description="A dedicated cloud computer that's always on, runs while you sleep, with full root access and persistent storage."
            ctaLabel="Get Started"
            ctaLoadingLabel="Setting up…"
            onCta={() => {}}
            loading={false}
            features={['Always on', 'Full root access', 'Persistent storage']}
          />
        </>
      );

    case 'empty-claim-with-credits':
      return (
        <>
          <Header />
          <ComputerHeroCard
            title="Kortix is now even better"
            description={
              <>
                Your plan now includes a dedicated cloud computer with{' '}
                <span className="text-foreground font-medium">$20/mo</span> in credits.
                Always on, runs while you sleep, full root access.
              </>
            }
            ctaLabel="Claim Computer"
            ctaLoadingLabel="Setting up…"
            onCta={() => {}}
            loading={false}
            features={['Included in your plan', 'Always on', 'Persistent storage']}
          />
        </>
      );

    case 'empty-claim-no-credits':
      return (
        <>
          <Header />
          <ComputerHeroCard
            title="Kortix is now even better"
            description="Your plan now includes a dedicated cloud computer. Always on, runs while you sleep, full root access."
            ctaLabel="Claim Computer"
            ctaLoadingLabel="Setting up…"
            onCta={() => {}}
            loading={false}
            features={['Included in your plan', 'Always on', 'Persistent storage']}
          />
        </>
      );

    case 'list-single': {
      const list = [mockSandbox({ sandbox_id: 'sb-solo', name: 'production' })];
      return (
        <>
          <Header count={list.length} showNewButton />
          <div className="flex flex-col gap-2">
            {list.map((sb) => (
              <InstanceCard key={sb.sandbox_id} sandbox={sb} onClick={() => {}} onSettings={() => {}} />
            ))}
          </div>
        </>
      );
    }

    case 'list-variety':
      return (
        <>
          <Header count={MOCK_SANDBOXES_VARIETY.length} showNewButton />
          <div className="flex flex-col gap-2">
            {MOCK_SANDBOXES_VARIETY.map((sb) => (
              <InstanceCard key={sb.sandbox_id} sandbox={sb} onClick={() => {}} onSettings={() => {}} />
            ))}
          </div>
        </>
      );

    case 'list-provisioning': {
      const list = [
        mockSandbox({
          sandbox_id: 'sb-prov',
          name: 'new-workspace',
          status: 'provisioning',
          metadata: { location: 'fsn1', serverType: 'cpx21' },
        }),
      ];
      return (
        <>
          <Header count={list.length} showNewButton />
          <div className="flex flex-col gap-2">
            {list.map((sb) => (
              <InstanceCard key={sb.sandbox_id} sandbox={sb} onClick={() => {}} onSettings={() => {}} />
            ))}
          </div>
        </>
      );
    }

    case 'fallback-list':
      return (
        <>
          <Header count={MOCK_FALLBACK_SERVERS.length} />
          <div className="flex flex-col gap-2">
            {MOCK_FALLBACK_SERVERS.map((srv, i) => (
              <FallbackInstanceCard
                key={srv.id}
                server={srv}
                isActive={i === 0}
                onClick={() => {}}
              />
            ))}
          </div>
        </>
      );

    case 'error':
      return (
        <>
          <Header />
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-destructive font-medium">Failed to load instances</p>
              <p className="text-xs text-destructive/70 mt-0.5">
                fetch failed: Error: read ECONNRESET
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => {}}>
              Retry
            </Button>
          </div>
        </>
      );

    case 'backups-empty':
      return (
        <>
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Archive className="h-5 w-5 text-muted-foreground" />
              Backups
              <span className="ml-1 flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500/90">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Auto
              </span>
            </h1>
            <p className="text-xs text-muted-foreground mt-1.5 font-mono">sandbox-debug-0001</p>
          </div>
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Backup description (optional)"
                className="flex-1 h-10 text-sm px-3.5 rounded-xl bg-muted/40 border border-border/50 outline-none placeholder:text-muted-foreground/50"
                readOnly
              />
              <Button className="gap-1.5 h-10" onClick={() => {}}>
                <Plus className="h-4 w-4" />
                Backup Now
              </Button>
            </div>
          </div>
          <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 p-8 flex flex-col items-center gap-4">
            <div className="flex items-center justify-center h-14 w-14 rounded-xl bg-muted/50">
              <HardDrive className="h-7 w-7 text-muted-foreground/40" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground/80">No backups yet</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Your first automatic backup will appear here soon.
              </p>
            </div>
          </div>
        </>
      );

    case 'loading':
      // Rendered outside the shell — handled in the parent switch.
      return null;

    default:
      return null;
  }
}
