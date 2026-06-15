'use client';

import { Reveal } from '@/components/home/reveal';
import { SkillsPage } from '@/components/home/interactive-demo/pages/skills-page';
import { Badge } from '@/components/ui/badge';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';
import {
  Brain,
  Calendar,
  Check,
  Clock,
  FileText,
  Hash,
  Sparkles,
  Table2,
} from 'lucide-react';
import { CAPABILITIES, type Capability } from './narrative';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

/* ─── Window chrome shared by every visual ──────────────────────────────── */

function ShowcaseFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-border dark:bg-background rounded-xl p-1 shadow-sm">
      <div className="bg-background dark:bg-primary/7 flex items-center gap-2 rounded-t-lg px-3.5 py-2.5">
        <span className="flex gap-1.5">
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        </span>
        <span className="text-muted-foreground ml-1.5 font-mono text-xs">{label}</span>
      </div>
      <div className="bg-background dark:bg-primary/7 relative h-[420px] overflow-hidden rounded-b-lg">
        {children}
      </div>
    </div>
  );
}

function BrandTile({ domain, name }: { domain: string; name: string }) {
  return (
    <span className="border-border bg-background flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
      <img src={favicon(domain)} alt={name} width={18} height={18} loading="lazy" />
    </span>
  );
}

/* ─── Connect ───────────────────────────────────────────────────────────── */

const CONNECT_APPS: [string, string, boolean][] = [
  ['github.com', 'GitHub', true],
  ['slack.com', 'Slack', true],
  ['salesforce.com', 'Salesforce', true],
  ['notion.so', 'Notion', false],
  ['linear.app', 'Linear', false],
  ['gmail.com', 'Gmail', false],
  ['hubspot.com', 'HubSpot', false],
  ['stripe.com', 'Stripe', false],
  ['drive.google.com', 'Drive', false],
];

const CONNECTOR_TYPES = ['App', 'MCP', 'OpenAPI', 'GraphQL', 'HTTP'];

function ConnectVisual() {
  return (
    <div className="flex h-full flex-col p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-foreground text-sm font-semibold">Integrations</span>
        <span className="text-muted-foreground text-xs">3,000+ apps</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {CONNECTOR_TYPES.map((t, i) => (
          <Badge key={t} size="sm" variant={i === 0 ? 'highlight' : 'outline'}>
            {t}
          </Badge>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CONNECT_APPS.map(([domain, name, connected]) => (
          <div
            key={name}
            className={cn(
              'border-border/60 bg-card flex items-center gap-2.5 rounded-md border p-2.5',
              connected && 'border-kortix-green/30',
            )}
          >
            <BrandTile domain={domain} name={name} />
            <span className="text-foreground truncate text-sm font-medium">{name}</span>
            {connected ? (
              <Badge size="sm" variant="success" className="ml-auto gap-1">
                <span className="bg-kortix-green size-1.5 rounded-full" /> Connected
              </Badge>
            ) : (
              <Badge size="sm" variant="outline" className="ml-auto">
                Connect
              </Badge>
            )}
          </div>
        ))}
      </div>
      <div className="from-background dark:from-primary/7 pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent" />
    </div>
  );
}

/* ─── Skills (reuses the live product surface) ──────────────────────────── */

function SkillsVisual() {
  return (
    <div className="h-full overflow-hidden p-5">
      <SkillsPage />
      <div className="from-background dark:from-primary/7 pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t to-transparent" />
    </div>
  );
}

/* ─── Memory ────────────────────────────────────────────────────────────── */

function MemoryRow({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="border-border/60 bg-card flex items-start gap-3 rounded-md border p-3">
      <span className="border-border bg-background text-foreground/70 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-foreground text-sm font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{sub}</div>
      </div>
    </div>
  );
}

function MemoryVisual() {
  return (
    <div className="flex h-full flex-col p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <Brain className="text-foreground/70 size-4" /> Memory
        </span>
        <span className="text-kortix-green inline-flex items-center gap-1.5 text-xs font-medium">
          <span className="bg-kortix-green size-1.5 animate-pulse rounded-full" /> synced 2h ago
        </span>
      </div>

      <div className="space-y-2.5">
        <MemoryRow
          icon={<Hash className="size-3.5" />}
          title="People & teams"
          sub="Works closely with Sara (Design), Dom (Eng) · reports to the founders"
        />
        <MemoryRow
          icon={<FileText className="size-3.5" />}
          title="Active projects"
          sub="Q3 launch · pricing revamp · enterprise onboarding"
        />
        <MemoryRow
          icon={<Hash className="size-3.5" />}
          title="Connected context"
          sub="#launch and #design Slack · 6 Notion docs · 12 Linear tickets"
        />
      </div>

      <div className="border-border/60 bg-muted/20 text-muted-foreground mt-auto flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
        <Calendar className="size-3.5 shrink-0" />
        Synthesized from Slack, Notion & Calendar — refreshed every 24 hours
      </div>
    </div>
  );
}

/* ─── Automations + Slack ───────────────────────────────────────────────── */

const SCHEDULES: [string, string][] = [
  ['Daily spend anomalies', '0 8 * * *'],
  ['Weekly pipeline digest', '0 7 * * 1'],
  ['Nightly ticket triage', '0 2 * * *'],
];

function AutomationsVisual() {
  return (
    <div className="flex h-full flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <Clock className="text-foreground/70 size-4" /> Scheduled
        </span>
        <span className="text-muted-foreground text-xs">running 24/7</span>
      </div>

      <div className="space-y-2">
        {SCHEDULES.map(([name, cron]) => (
          <div
            key={name}
            className="border-border/60 bg-card flex items-center gap-3 rounded-md border px-3 py-2.5"
          >
            <span className="border-kortix-green/20 bg-kortix-green/10 text-kortix-green flex size-7 shrink-0 items-center justify-center rounded-lg border">
              <Clock className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-foreground truncate text-sm font-medium">{name}</div>
              <div className="text-muted-foreground font-mono text-xs">{cron}</div>
            </div>
            <span className="bg-kortix-green flex h-4 w-7 items-center justify-end rounded-full p-0.5">
              <span className="size-3 rounded-full bg-white" />
            </span>
          </div>
        ))}
      </div>

      {/* Slack post */}
      <div className="border-border bg-card mt-auto rounded-md border p-3">
        <div className="flex items-center gap-2">
          <span className="border-border bg-background flex size-6 items-center justify-center rounded-md border">
            <img src={favicon('slack.com')} alt="Slack" width={14} height={14} />
          </span>
          <span className="text-foreground text-xs font-semibold">Kortix</span>
          <Badge size="sm" variant="muted" className="font-mono">
            APP
          </Badge>
          <span className="text-muted-foreground text-xs">#finance · 8:00 AM</span>
        </div>
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          <span className="text-foreground font-medium">Morning — 3 spend anomalies overnight.</span>{' '}
          AWS +38% vs 7-day avg, two duplicate SaaS charges flagged. Full breakdown in thread ↓
        </p>
      </div>
    </div>
  );
}

/* ─── Workspace (split panes) ───────────────────────────────────────────── */

function WorkspaceVisual() {
  return (
    <div className="flex h-full flex-col p-3">
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
        {/* chat pane */}
        <div className="border-border bg-card flex min-h-0 flex-col overflow-hidden rounded-md border">
          <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs">
            <Sparkles className="size-3.5" /> Chat
          </div>
          <div className="space-y-2.5 p-3">
            <div className="bg-muted/40 text-foreground ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm px-2.5 py-1.5 text-xs">
              Build a Q3 revenue report from the warehouse
            </div>
            <div className="text-muted-foreground text-xs leading-relaxed">
              Pulled <span className="text-foreground font-medium">data.csv</span>, wrote
              <span className="text-foreground font-medium"> report.md</span> and charted it →
            </div>
            <div className="border-border/60 text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-[11px]">
              <Check className="text-kortix-green size-3" /> 3 files opened in the editor
            </div>
          </div>
        </div>

        {/* editor pane with tabs */}
        <div className="border-border bg-card flex min-h-0 flex-col overflow-hidden rounded-md border">
          <div className="border-border flex items-center gap-1 border-b px-2 py-1.5">
            <span className="bg-muted/60 text-foreground flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium">
              <FileText className="size-3" /> report.md
            </span>
            <span className="text-muted-foreground flex items-center gap-1.5 rounded px-2 py-1 text-[11px]">
              <Table2 className="size-3" /> data.csv
            </span>
          </div>
          <div className="space-y-2 p-3">
            <div className="bg-foreground/80 h-2.5 w-1/2 rounded-sm" />
            <div className="bg-foreground/15 h-2 w-full rounded-sm" />
            <div className="bg-foreground/15 h-2 w-11/12 rounded-sm" />
            <div className="bg-foreground/15 h-2 w-4/5 rounded-sm" />
            <div className="mt-3 flex h-16 items-end gap-1.5">
              {[40, 65, 30, 80, 55, 70].map((h, i) => (
                <span
                  key={i}
                  className="bg-kortix-green/70 w-full rounded-sm"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="text-muted-foreground mt-2 flex shrink-0 items-center justify-center gap-1.5 text-[11px]">
        <span className="bg-muted-foreground/40 size-1 rounded-full" /> Layout persists across sessions
      </div>
    </div>
  );
}

const VISUALS: Record<Capability['visual'], { label: string; node: React.ReactNode }> = {
  connect: { label: 'kortix · integrations', node: <ConnectVisual /> },
  skills: { label: 'kortix · skills', node: <SkillsVisual /> },
  memory: { label: 'kortix · memory', node: <MemoryVisual /> },
  automations: { label: 'kortix · schedules', node: <AutomationsVisual /> },
  workspace: { label: 'kortix · workspace', node: <WorkspaceVisual /> },
};

/* ─── Row ───────────────────────────────────────────────────────────────── */

function FeatureRow({ cap, index }: { cap: Capability; index: number }) {
  const reversed = index % 2 === 1;
  const visual = VISUALS[cap.visual];

  return (
    <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <Reveal className={cn(reversed && 'lg:order-2')}>
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {cap.eyebrow}
        </p>
        <h3 className="text-foreground mt-3 text-2xl font-medium tracking-tight sm:text-3xl">
          {cap.title}
        </h3>
        <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">
          {cap.description}
        </p>
        <ul className="mt-6 max-w-md space-y-2.5">
          {cap.bullets.map((b) => (
            <li key={b} className="text-muted-foreground flex gap-2.5 text-[15px] leading-relaxed">
              <KortixAsterisk index={index} />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal delay={0.1} className={cn(reversed && 'lg:order-1')}>
        <ShowcaseFrame label={visual.label}>{visual.node}</ShowcaseFrame>
      </Reveal>
    </div>
  );
}

export function Capabilities() {
  return (
    <section className="mx-auto max-w-6xl space-y-20 px-6 py-16 sm:space-y-28 sm:py-24 lg:px-0">
      {CAPABILITIES.map((cap, i) => (
        <FeatureRow key={cap.id} cap={cap} index={i} />
      ))}
    </section>
  );
}
