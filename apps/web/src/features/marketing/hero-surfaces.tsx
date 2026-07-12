'use client';

import { InteractiveDemoSection } from '@/components/home/interactive-demo-section';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { ArrowUpRight, Code2, Monitor, Smartphone, Terminal } from 'lucide-react';
import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { useState } from 'react';

type SurfaceId = 'web' | 'slack' | 'teams' | 'mobile' | 'cli' | 'sdk';

type Surface = {
  id: SurfaceId;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const SURFACES: Surface[] = [
  { id: 'web', label: 'Web & desktop', icon: Monitor },
  { id: 'slack', label: 'Slack', icon: Icon.Slack },
  { id: 'teams', label: 'MS Teams', icon: Icon.MicrosoftTeams },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
  { id: 'cli', label: 'CLI', icon: Terminal },
  { id: 'sdk', label: 'API / SDK', icon: Code2 },
];

/* ── shared bits ─────────────────────────────────────────────────────────── */

function MonoLine({ line }: { line: string }) {
  const slash = line.indexOf('//');
  const hash = line.indexOf('#');
  const idxs = [slash, hash].filter((i) => i >= 0);
  const ci = idxs.length ? Math.min(...idxs) : -1;
  if (ci >= 0) {
    return (
      <div className="whitespace-pre">
        <span className="text-foreground/85">{line.slice(0, ci)}</span>
        <span className="text-muted-foreground/55">{line.slice(ci)}</span>
      </div>
    );
  }
  return <div className="text-foreground/85 whitespace-pre">{line || ' '}</div>;
}

function CodeWindow({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="bg-card flex h-full flex-col">
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-3 font-mono text-xs">
        <span className="flex gap-1.5">
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        </span>
        <span className="ml-2">{title}</span>
      </div>
      <div className="flex-1 overflow-auto p-5 font-mono text-xs leading-relaxed sm:p-6 sm:text-sm">
        {lines.map((line, i) => (
          <MonoLine key={`${i}:${line}`} line={line} />
        ))}
      </div>
    </div>
  );
}

/* ── chat surfaces (Slack / Teams) ───────────────────────────────────────── */

function ChatBubble({
  name,
  app,
  avatar,
  children,
}: {
  name: string;
  app?: boolean;
  avatar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {avatar}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground text-sm font-semibold">{name}</span>
          {app && (
            <span className="bg-muted text-muted-foreground rounded-[0.2rem] px-1 py-px text-[8px] font-medium">
              APP
            </span>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 text-sm leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function KortixAvatar() {
  return (
    <span className="bg-primary flex size-8 shrink-0 items-center justify-center rounded-md">
      <KortixLogo size={15} className="text-background" />
    </span>
  );
}

function PersonAvatar({ initial }: { initial: string }) {
  return (
    <span className="bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold">
      {initial}
    </span>
  );
}

function MorningBrief() {
  return (
    <div className="space-y-1.5">
      <p className="text-foreground font-medium">Here's what changed since Monday:</p>
      <ul className="space-y-1">
        <li>· 14 PRs merged · 3 need your review</li>
        <li>· Stripe revenue +$3,482</li>
        <li>· 2 enterprise leads replied</li>
        <li>· Renewal drafted for Acme — waiting on sign-off</li>
      </ul>
      <p>Want the full report?</p>
    </div>
  );
}

function ChatSurface({ brand }: { brand: 'slack' | 'teams' }) {
  const BrandIcon = brand === 'slack' ? Icon.Slack : Icon.MicrosoftTeams;
  return (
    <div className="bg-background flex h-full flex-col">
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2.5">
          <BrandIcon className="size-5" />
          <span className="text-foreground text-sm font-semibold">Kortix</span>
          {brand === 'teams' && (
            <Badge variant="kortix" size="sm" className="rounded">
              Coming soon
            </Badge>
          )}
        </div>
        <span className="text-muted-foreground font-mono text-xs">#company-ops</span>
      </div>

      <div className="flex flex-1 flex-col justify-end gap-5 overflow-y-auto p-5">
        <ChatBubble name="Marko" avatar={<PersonAvatar initial="M" />}>
          @Kortix what changed in our repo since Monday?
        </ChatBubble>
        <ChatBubble name="Kortix" app avatar={<KortixAvatar />}>
          <MorningBrief />
        </ChatBubble>
      </div>

      <div className="border-border border-t p-3">
        <div className="border-border text-muted-foreground/70 rounded-lg border px-3 py-2 text-sm">
          Message Kortix…
        </div>
      </div>
    </div>
  );
}

const MOBILE_SHOTS = [
  '/images/mobile-app/app-1.png',
  '/images/mobile-app/app-2.png',
  '/images/mobile-app/app-3.png',
];

function MobileSurface() {
  return (
    <div className="bg-card relative flex h-full items-center justify-center gap-4 overflow-hidden p-6 sm:gap-7 sm:p-10">
      <Badge variant="kortix" className="absolute top-5 left-5 z-10 rounded">
        Coming soon
      </Badge>
      {MOBILE_SHOTS.map((src, i) => (
        <div
          key={src}
          className={cn(
            'border-border bg-background h-full max-h-[460px] shrink-0 overflow-hidden rounded-2xl border shadow-md',
            i === 1 ? 'sm:-translate-y-3' : 'sm:translate-y-3',
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="Kortix mobile app" className="block h-full w-auto object-contain" />
        </div>
      ))}
    </div>
  );
}

const CLI_LINES = [
  '$ kortix init acme-ops',
  '✓ Initialized Kortix project "acme-ops"  # everything is files',
  '',
  '$ kortix run "draft the renewal for Acme"',
  '✓ session/renewal-acme · sandbox booted   # isolated branch',
  '→ change request opened: sales/renewals/acme.md',
  '',
  '$ kortix triggers add morning-brief --cron "0 8 * * 1-5"',
  '✓ scheduled · delivers to #company-ops',
];

const SDK_LINES = [
  'import { createKortix, generateSessionId } from "@kortix/sdk";',
  '',
  '// one typed client for the Kortix API + the agent runtime',
  'const kortix = createKortix({',
  '  backendUrl: "https://api.kortix.com/v1",',
  '  getToken: () => process.env.KORTIX_API_KEY!,',
  '});',
  '',
  '// the same agents your whole company shares',
  'const sessionId = generateSessionId();',
  'await kortix.project(projectId).sessions.create({ session_id: sessionId });',
  '',
  'const session = kortix.session(projectId, sessionId);',
  'await session.start();',
  'await session.send("Draft the renewal for Acme", { agent: "go-to-market" });',
];

function SurfacePanel({ surface }: { surface: SurfaceId }) {
  switch (surface) {
    case 'web':
      return <InteractiveDemoSection embedded />;
    case 'slack':
      return <ChatSurface brand="slack" />;
    case 'teams':
      return <ChatSurface brand="teams" />;
    case 'mobile':
      return <MobileSurface />;
    case 'cli':
      return <CodeWindow title="kortix — terminal" lines={CLI_LINES} />;
    case 'sdk':
      return (
        <div className="relative h-full">
          <CodeWindow title="renewal.ts" lines={SDK_LINES} />
          <Link
            href="/docs/sdk"
            className="border-border bg-card/90 text-foreground hover:bg-foreground/[0.04] absolute right-4 bottom-4 inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium shadow-sm backdrop-blur transition-colors duration-fast"
          >
            View the SDK docs
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      );
  }
}

export function HeroSurfaces() {
  const [active, setActive] = useState<SurfaceId>('web');

  return (
    <div className="w-full">
      <div className="flex w-full gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SURFACES.map((s) => {
          const isActive = s.id === active;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              aria-current={isActive ? 'true' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-fast',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]',
              )}
            >
              <s.icon className="size-4" />
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="border-border bg-card mt-3 h-[520px] overflow-hidden rounded-xl border sm:h-[600px]">
        <SurfacePanel surface={active} />
      </div>
    </div>
  );
}
