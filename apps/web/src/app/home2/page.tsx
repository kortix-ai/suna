import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import {
  IconAgent,
  IconArrowUpRight,
  IconBot,
  IconCalendar,
  IconCheck,
  IconCode,
  IconCopy,
  IconExternal,
  IconFileText,
  IconFolder,
  IconMessage,
  IconProject,
  IconSettings,
  IconTerminal,
  IconTrigger,
  IconUsers,
  type Icon,
} from '@/components/ui/kortix-icons';

const navItems = [
  { label: 'README', href: '/home2', active: true },
  { label: 'DOCS', href: '/docs' },
  { label: 'PRODUCT', href: '/technology' },
  { label: 'ENTERPRISE', href: '/enterprise' },
  { label: 'RESOURCES', href: '/tutorials' },
];

const operatingSurfaces = [
  'Projects',
  'Sessions',
  'Agents',
  'Skills',
  'Connectors',
  'Triggers',
  'Secrets',
  'Approvals',
];

const builtFor = [
  'AI-native operators',
  'Internal platform teams',
  'Agencies building agent workforces',
  'Enterprises that need ownership',
];

type FeatureCardData = {
  n: string;
  icon: Icon;
  title: string;
  desc: string;
  meta?: string[];
  command?: string;
};

const featureCards: FeatureCardData[] = [
  {
    n: '01',
    icon: IconProject,
    title: 'Project OS.',
    desc: 'Every company gets a durable project workspace with sessions, files, agents, memory, and account ownership.',
    meta: ['accounts', 'projects', 'sessions'],
  },
  {
    n: '02',
    icon: IconTerminal,
    title: 'Real runtime.',
    desc: 'Agents work inside a Linux environment with browser access, file operations, package managers, and live tools.',
    command: '$ kortix session start growth-ops',
  },
  {
    n: '03',
    icon: IconBot,
    title: 'Specialist agents.',
    desc: 'Define workers for finance, support, research, sales, ops, and engineering with scoped skills and tools.',
    meta: ['finance', 'support', 'sales', '+50'],
  },
  {
    n: '04',
    icon: IconFileText,
    title: 'Deliverable first.',
    desc: 'The output is a finished deck, doc, sheet, report, PR, or browser workflow, not another chat transcript.',
    meta: ['docs', 'sheets', 'slides', 'prs'],
  },
  {
    n: '05',
    icon: IconUsers,
    title: 'Account and project access.',
    desc: 'Invite people into accounts, grant project roles, and keep org-level authority separate from runtime authority.',
    meta: ['owner', 'admin', 'member', 'viewer'],
  },
  {
    n: '06',
    icon: IconTrigger,
    title: 'Work on triggers.',
    desc: 'Run agents from schedules, webhooks, channels, GitHub events, support tickets, or manual handoffs.',
    meta: ['cron', 'webhook', 'slack', 'github'],
  },
  {
    n: '07',
    icon: IconCode,
    title: 'Git-native memory.',
    desc: 'The company improves as files, skills, configs, and decisions become reviewable changes in the repo.',
    command: 'change-request: support-agent -> main',
  },
  {
    n: '08',
    icon: IconSettings,
    title: 'Bring your stack.',
    desc: 'Use managed cloud for speed, self-host when needed, and bring your own model keys or subscriptions.',
    meta: ['cloud', 'vpc', 'self-host', 'byok'],
  },
  {
    n: '09',
    icon: IconCheck,
    title: 'Human control.',
    desc: 'Approvals, logs, scoped credentials, audit trails, and policy gates keep autonomous work reviewable.',
    command: 'approval = "human_on_risk"',
  },
];

const codeLines = [
  'project = "acme-company"',
  'source = "github.com/acme/company-os"',
  '',
  '[[agents]]',
  'name = "finance-operator"',
  'tools = ["browser", "sheets", "slack"]',
  'skills = ["board-reporting", "invoice-review"]',
  '',
  '[[triggers.cron]]',
  'agent = "finance-operator"',
  'schedule = "0 8 * * MON"',
  'approval = "human_on_risk"',
];

function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn('pointer-events-none select-none', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/kortix-symbol.svg"
        alt=""
        className="h-full w-full object-contain opacity-100 dark:invert"
      />
    </div>
  );
}

function MiniLogo() {
  return (
    <Link href="/home2" className="inline-flex items-center">
      <KortixLogo size={24} variant="logomark" />
    </Link>
  );
}

function SectionHeader({ title, label }: { title: string; label?: string }) {
  return (
    <div className="flex items-center gap-4">
      {title ? (
        <h2 className="shrink-0 text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h2>
      ) : null}
      <Separator className="flex-1 bg-border/70" />
      {label ? (
        <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </span>
      ) : null}
    </div>
  );
}

function CommandBox() {
  return (
    <Card className="mt-9 gap-0 overflow-hidden rounded-2xl border-border/80 bg-card/70 py-0">
      <div className="grid grid-cols-4 border-b border-border/70 text-xs">
        {['CLI', 'Prompt', 'MCP', 'Skills'].map((tab, index) => (
          <div
            key={tab}
            className={cn(
              'flex h-10 items-center border-r border-border/60 px-4 last:border-r-0',
              index === 0 ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <span
              className={index === 0 ? 'border-b border-foreground pb-2' : ''}
            >
              {tab}
            </span>
          </div>
        ))}
      </div>
      <div className="flex min-h-14 items-center justify-between gap-4 px-4 font-mono text-xs text-foreground">
        <div className="min-w-0 truncate">
          <span className="text-muted-foreground">npx</span> kortix init
          company-os
        </div>
        <IconCopy
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.5}
        />
      </div>
    </Card>
  );
}

function FeatureCard({ card }: { card: FeatureCardData }) {
  const Icon = card.icon;

  return (
    <Card className="group min-h-[174px] gap-0 overflow-hidden rounded-2xl border-border/70 bg-card/60 py-0 transition-colors hover:bg-card">
      <div className="flex h-full flex-col p-5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-muted-foreground">
            {card.n}
          </span>
          <span className="flex size-8 items-center justify-center rounded-2xl border border-border/60 bg-background/70 text-muted-foreground transition-colors group-hover:text-foreground">
            <Icon className="size-3.5" strokeWidth={1.5} />
          </span>
        </div>
        <h3 className="mt-3 text-sm font-semibold text-foreground">
          {card.title}
        </h3>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          {card.desc}
        </p>
        <div className="mt-auto pt-4">
          {card.meta ? (
            <div className="flex flex-wrap gap-1.5">
              {card.meta.map((item) => (
                <Badge
                  key={item}
                  variant="secondary"
                  size="sm"
                  className="font-mono font-normal"
                >
                  {item}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-xs text-muted-foreground">
              {card.command}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function LeftRail() {
  return (
    <aside className="relative flex min-h-[100svh] flex-col overflow-hidden border-r border-border bg-background px-7 py-6 lg:fixed lg:inset-y-0 lg:left-0 lg:w-[41.65vw]">
      <MiniLogo />

      <BrandMark className="absolute left-[39%] top-[31%] h-[270px] w-[270px] -translate-x-1/2 -translate-y-1/2 rotate-[-8deg] opacity-[0.07] lg:h-[390px] lg:w-[390px]" />

      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[34%] bg-[repeating-linear-gradient(90deg,rgba(0,0,0,0.045)_0_1px,transparent_1px_9px)] dark:bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.055)_0_1px,transparent_1px_9px)] lg:block" />
      <div className="pointer-events-none absolute inset-x-0 bottom-[27%] h-px bg-border/60" />
      <div className="pointer-events-none absolute bottom-[27%] left-0 right-0 h-28 bg-[repeating-linear-gradient(0deg,rgba(0,0,0,0.035)_0_1px,transparent_1px_14px)] dark:bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.045)_0_1px,transparent_1px_14px)]" />

      <div className="relative z-10 mt-auto pb-20 sm:pb-28">
        <Badge
          asChild
          variant="secondary"
          className="gap-2 rounded-full px-3 py-1.5 text-sm font-normal"
        >
          <Link href="/technology">
            <IconAgent className="size-3.5" strokeWidth={1.5} />
            Introducing | Company OS
            <IconArrowUpRight className="size-3.5" strokeWidth={1.5} />
          </Link>
        </Badge>

        <h1 className="mt-7 max-w-[560px] text-[42px] font-medium leading-[1.08] tracking-[-0.035em] text-foreground sm:text-[52px] lg:text-[50px] xl:text-[60px]">
          Run your company on agents you own
        </h1>
        <p className="mt-5 max-w-[500px] text-sm leading-6 text-muted-foreground">
          Kortix turns one repo into an AI command center: agents, triggers,
          tools, memory, projects, approvals, and deliverables in one workspace.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="h-11 px-7">
            <Link href="/auth">
              Get Started{' '}
              <IconArrowUpRight className="size-4" strokeWidth={1.5} />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-11 px-7">
            <Link href="/enterprise">Request demo</Link>
          </Button>
        </div>
      </div>

      <div className="relative z-10 mt-8 flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="https://discord.com/invite/RvFhXUdZ9H"
            className="hover:text-foreground"
          >
            Community
          </Link>
          <span>/</span>
          <Link href="/pricing" className="hover:text-foreground">
            Pricing
          </Link>
          <span>/</span>
          <Link href="/legal" className="hover:text-foreground">
            Legal
          </Link>
          <span>/</span>
          <Link href="/careers" className="hover:text-foreground">
            Careers
          </Link>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <span>GitHub</span>
          <IconExternal className="size-3" strokeWidth={1.5} />
        </div>
      </div>
    </aside>
  );
}

function TopNav() {
  return (
    <nav className="sticky top-0 z-40 flex min-h-14 border-b border-border bg-background/95 backdrop-blur">
      <div className="hidden flex-1 grid-cols-5 text-xs sm:grid">
        {navItems.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className={cn(
              'flex items-center justify-center border-r border-border/70 font-mono uppercase tracking-[0.06em] text-muted-foreground transition hover:bg-muted/40 hover:text-foreground',
              item.active && 'border-b border-b-foreground text-foreground',
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2 px-3 py-2">
        <Button
          asChild
          variant="inverse"
          size="sm"
          className="font-mono uppercase tracking-[0.08em]"
        >
          <Link href="/auth">
            Sign-in <IconArrowUpRight className="size-3.5" strokeWidth={1.5} />
          </Link>
        </Button>
      </div>
    </nav>
  );
}

function BuiltForStrip() {
  return (
    <section className="mt-8 border-t border-border/60 pt-6">
      <SectionHeader title="" label="Built for" />
      <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {builtFor.map((item) => (
          <Card
            key={item}
            className="gap-0 rounded-2xl border-border/70 bg-card/50 px-4 py-3"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <IconFolder className="size-4" strokeWidth={1.5} />
              {item}
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function FrameworkSection() {
  return (
    <section className="mt-10 pb-20">
      <SectionHeader title="Framework" />
      <p className="mt-4 text-sm leading-6 text-muted-foreground">
        Kortix is the operating framework for autonomous company work: declare
        the workspace, run sessions in isolated environments, and keep the
        important changes reviewable.
      </p>

      <div className="mt-8 grid gap-3 lg:grid-cols-[1fr_260px]">
        <Card className="gap-0 overflow-hidden rounded-2xl border-border/70 bg-card/60 py-0">
          <div className="border-b border-border/70 px-4 py-3 font-mono text-xs text-muted-foreground">
            <IconFileText className="mr-2 inline size-3.5" strokeWidth={1.5} />
            kortix.toml
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-xs leading-6 text-foreground">
            {codeLines.map((line, index) => (
              <code key={`${line}-${index}`} className="block">
                <span className="mr-5 text-muted-foreground">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {line}
              </code>
            ))}
          </pre>
        </Card>

        <div className="grid gap-3">
          {[
            [
              'Source of truth',
              'Agents, skills, triggers, and memory are files you can diff.',
            ],
            [
              'Runtime isolation',
              'Every session runs in a scoped workspace with explicit access.',
            ],
            [
              'Review gates',
              'Keep approval at the points where autonomous work can matter.',
            ],
          ].map(([title, desc], index) => (
            <Card
              key={title}
              className="gap-0 rounded-2xl border-border/70 bg-card/60 p-5"
            >
              <div className="font-mono text-xs text-muted-foreground">
                0{index + 1}
              </div>
              <div className="mt-2 text-sm font-semibold uppercase tracking-[0.08em] text-foreground">
                {title}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {desc}
              </p>
            </Card>
          ))}
        </div>
      </div>

      <div className="mt-10 grid gap-3 md:grid-cols-3">
        {[
          [
            'Open core',
            'Audit, extend, and self-host the runtime where your company data already lives.',
          ],
          [
            'Managed cloud',
            'Use Kortix cloud when you want setup speed, elastic sessions, and managed operations.',
          ],
          [
            'No lock-in',
            'Bring your models, credentials, git repos, tools, and workflows with you.',
          ],
        ].map(([title, desc]) => (
          <Card
            key={title}
            className="gap-0 rounded-2xl border-border/70 bg-card/60 p-5"
          >
            <IconCheck className="size-4 text-foreground" strokeWidth={1.6} />
            <h3 className="mt-4 text-sm font-semibold text-foreground">
              {title}
            </h3>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              {desc}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ReadmePane() {
  return (
    <main className="bg-background lg:ml-[41.65vw]">
      <TopNav />
      <div className="mx-auto max-w-[1140px] px-5 py-8 sm:px-8 lg:px-10 xl:px-12">
        <section>
          <SectionHeader title="README" />
          <p className="mt-8 max-w-[980px] text-sm leading-7 text-muted-foreground">
            <strong className="font-medium text-foreground">
              Kortix is the AI command center for your company.
            </strong>{' '}
            It turns a project repo into a living company workspace where agents
            plan, operate across tools, produce finished deliverables, and leave
            a reviewable trail behind.
          </p>

          <CommandBox />

          <div className="mt-5 flex flex-wrap gap-2">
            {operatingSurfaces.map((surface) => (
              <Badge
                key={surface}
                variant="outline"
                size="sm"
                className="font-mono font-normal"
              >
                {surface}
              </Badge>
            ))}
          </div>
        </section>

        <BuiltForStrip />

        <section className="mt-8">
          <SectionHeader title="Features" />
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {featureCards.map((card) => (
              <FeatureCard key={card.n} card={card} />
            ))}
          </div>
        </section>

        <section className="mt-10">
          <SectionHeader title="Workflow" />
          <div className="mt-6 grid gap-3 md:grid-cols-4">
            {[
              ['Describe', IconMessage, 'Start with the business outcome.'],
              [
                'Run',
                IconTrigger,
                'Kortix picks tools, files, and browser paths.',
              ],
              ['Verify', IconCheck, 'The worker checks output before handoff.'],
              ['Commit', IconCode, 'Useful knowledge becomes durable state.'],
            ].map(([title, IconCmp, desc]) => {
              const WorkflowIcon = IconCmp as Icon;
              return (
                <Card
                  key={title as string}
                  className="gap-0 rounded-2xl border-border/70 bg-card/60 p-5"
                >
                  <WorkflowIcon
                    className="size-4 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                  <h3 className="mt-4 text-sm font-semibold text-foreground">
                    {title as string}
                  </h3>
                  <p className="mt-2 text-sm leading-5 text-muted-foreground">
                    {desc as string}
                  </p>
                </Card>
              );
            })}
          </div>
        </section>

        <FrameworkSection />
      </div>
    </main>
  );
}

export default function Home2Page() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <LeftRail />
      <ReadmePane />
      <div className="fixed bottom-4 right-4 hidden items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1.5 font-mono text-xs text-muted-foreground shadow-sm backdrop-blur lg:flex">
        <IconCalendar className="size-3" strokeWidth={1.5} />
        <Kbd>home2</Kbd>
      </div>
    </div>
  );
}
