/* eslint-disable @next/next/no-img-element */
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  Coffee,
  Database,
  FileText,
  GitMerge,
  GitPullRequest,
  KeyRound,
  Mail,
  MessagesSquare,
  PhoneCall,
  Radar,
  Receipt,
  ScrollText,
  Send,
  ShieldCheck,
  Siren,
  Tag,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
  Users,
  UserSearch,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

export type UseCaseCoverProps = { post: Post; featured?: boolean };

// ── shared surface + building blocks ────────────────────────────────────────

function CoverBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="from-muted/60 via-background to-primary/[0.08] absolute inset-0 overflow-hidden bg-gradient-to-br">
      <div className="absolute inset-0 bg-[url('/grain-texture.png')] bg-repeat opacity-[0.1]" />
      {children}
    </div>
  );
}

const TILE =
  'relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl shadow-md shadow-black/10 ring-1 ring-black/5 dark:ring-white/10 sm:size-14';
const ROW =
  'absolute inset-0 flex items-center justify-center gap-3 transition-transform duration-500 group-hover:scale-[1.03] sm:gap-4';
const CONNECTOR =
  'via-border absolute top-1/2 left-1/2 h-px w-[180px] -translate-x-1/2 -translate-y-1/2 bg-gradient-to-r from-transparent to-transparent';

function Rings({ sizes }: { sizes: number[] }) {
  return (
    <>
      {sizes.map((d) => (
        <div
          key={d}
          className="border-border/70 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border"
          style={{ width: d, height: d }}
        />
      ))}
    </>
  );
}

function Glow({ className }: { className: string }) {
  return (
    <div
      className={cn(
        'absolute top-1/2 left-1/2 size-32 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl',
        className,
      )}
    />
  );
}

// Logo tiles: avatar logos fill the tile; mark logos sit on a white chip.
function Avatar({ src, alt }: { src: string; alt: string }) {
  return (
    <div className={TILE}>
      <img src={src} alt={alt} className="size-full object-cover" />
    </div>
  );
}
function Mark({ src, alt }: { src: string; alt: string }) {
  return (
    <div className={cn(TILE, 'bg-white p-2.5')}>
      <img src={src} alt={alt} className="size-full object-contain" />
    </div>
  );
}
function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(TILE, 'bg-card', className)}>{children}</div>;
}

const Kortix = () => <Avatar src="/usecases/logos/kortix.png" alt="Kortix" />;
const Plain = () => <Avatar src="/usecases/logos/plain.png" alt="Plain" />;
const Slack = () => <Mark src="/usecases/logos/slack.webp" alt="Slack" />;
const GitHub = () => <Mark src="/usecases/logos/github.svg" alt="GitHub" />;
const Linear = () => <Avatar src="/usecases/logos/linear.png" alt="Linear" />;

// ── motifs ──────────────────────────────────────────────────────────────────

function RowCover({ children }: { children: ReactNode }) {
  return (
    <CoverBackdrop>
      <div className={CONNECTOR} />
      <div className={ROW}>{children}</div>
    </CoverBackdrop>
  );
}

function DuoCover({ a, b }: { a: ReactNode; b: ReactNode }) {
  return (
    <CoverBackdrop>
      <div className="absolute inset-0 flex items-center justify-center gap-3 transition-transform duration-500 group-hover:scale-[1.03] sm:gap-4">
        {a}
        <span className="text-muted-foreground/40 text-lg font-light">×</span>
        {b}
      </div>
    </CoverBackdrop>
  );
}

function FeatureCover({ children, glow }: { children: ReactNode; glow: string }) {
  return (
    <CoverBackdrop>
      <Glow className={glow} />
      <div className="absolute inset-0 flex items-center justify-center transition-transform duration-500 group-hover:scale-[1.03]">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-card shadow-lg shadow-black/10 ring-1 ring-black/5 dark:ring-white/10 sm:size-20">
          {children}
        </div>
      </div>
    </CoverBackdrop>
  );
}

function HeroCover({ children }: { children: ReactNode }) {
  return (
    <CoverBackdrop>
      <Rings sizes={[110, 175, 240]} />
      <Glow className="bg-primary/10" />
      <div className="absolute inset-0 flex items-center justify-center transition-transform duration-500 group-hover:scale-[1.03]">
        <div className="relative">
          <div className="grid size-16 place-items-center rounded-2xl bg-white shadow-lg shadow-black/10 ring-1 ring-black/5 sm:size-20">
            {children}
          </div>
          <div className="absolute -right-1.5 -bottom-1.5 overflow-hidden rounded-lg shadow-md ring-[3px] ring-white">
            <img
              src="/usecases/logos/kortix.png"
              alt="Kortix"
              className="size-7 object-cover sm:size-8"
            />
          </div>
        </div>
      </div>
    </CoverBackdrop>
  );
}

function OrbitCover({ center, satellites }: { center: ReactNode; satellites: ReactNode[] }) {
  return (
    <CoverBackdrop>
      <Rings sizes={[120, 188]} />
      {satellites.map((node, i) => {
        const angle = (i / satellites.length) * 360 + 45;
        return (
          <div
            key={i}
            className="absolute top-1/2 left-1/2"
            style={{ transform: `translate(-50%,-50%) rotate(${angle}deg) translate(84px) rotate(${-angle}deg)` }}
          >
            {node}
          </div>
        );
      })}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">{center}</div>
    </CoverBackdrop>
  );
}

const ic = 'size-5 sm:size-6';
const big = 'size-8 sm:size-9';

// ── registry ────────────────────────────────────────────────────────────────

export const USE_CASE_COVERS: Record<string, ComponentType<UseCaseCoverProps>> = {
  'customer-support': () => (
    <RowCover>
      <Kortix />
      <Plain />
      <Kortix />
    </RowCover>
  ),
  'slack-control-pane': () => (
    <OrbitCover
      center={<Kortix />}
      satellites={[
        <Slack key="s" />,
        <GitHub key="g" />,
        <Linear key="l" />,
        <IconTile key="d">
          <Database className={cn(ic, 'text-foreground/70')} />
        </IconTile>,
      ]}
    />
  ),
  'docs-maintainer': () => (
    <RowCover>
      <IconTile>
        <GitMerge className={cn(ic, 'text-foreground/70')} />
      </IconTile>
      <Kortix />
      <IconTile>
        <FileText className={cn(ic, 'text-foreground/70')} />
      </IconTile>
    </RowCover>
  ),
  'qa-agent': () => (
    <RowCover>
      <IconTile>
        <GitPullRequest className={cn(ic, 'text-foreground/70')} />
      </IconTile>
      <Kortix />
      <div className={cn(TILE, 'bg-emerald-500 text-white')}>
        <CheckCircle2 className={ic} />
      </div>
    </RowCover>
  ),
  'standup-summary': () => (
    <RowCover>
      <Slack />
      <Linear />
      <GitHub />
    </RowCover>
  ),
  'release-notes': () => (
    <RowCover>
      <GitHub />
      <Kortix />
      <IconTile>
        <Tag className={cn(ic, 'text-foreground/70')} />
      </IconTile>
    </RowCover>
  ),
  'meeting-notes': () => (
    <RowCover>
      <IconTile>
        <CalendarClock className={cn(ic, 'text-foreground/70')} />
      </IconTile>
      <Kortix />
      <Linear />
    </RowCover>
  ),
  'employee-onboarding': () => (
    <OrbitCover
      center={<Kortix />}
      satellites={[
        <Slack key="s" />,
        <Linear key="l" />,
        <IconTile key="u">
          <UserPlus className={cn(ic, 'text-foreground/70')} />
        </IconTile>,
      ]}
    />
  ),
  'dependency-upgrades': () => (
    <HeroCover>
      <img src="/usecases/logos/github.svg" alt="GitHub" className="size-9 object-contain sm:size-11" />
    </HeroCover>
  ),
  'inbox-triage': () => (
    <DuoCover
      a={
        <IconTile>
          <Mail className={cn(ic, 'text-sky-500')} />
        </IconTile>
      }
      b={<Linear />}
    />
  ),
  'weekly-report': () => (
    <DuoCover
      a={
        <IconTile>
          <BarChart3 className={cn(ic, 'text-indigo-500')} />
        </IconTile>
      }
      b={<Slack />}
    />
  ),
  'office-snacks': () => (
    <DuoCover
      a={
        <IconTile>
          <Coffee className={cn(ic, 'text-rose-500')} />
        </IconTile>
      }
      b={<Slack />}
    />
  ),
  'access-requests': () => (
    <DuoCover
      a={
        <IconTile>
          <KeyRound className={cn(ic, 'text-amber-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'oncall-triage': () => (
    <DuoCover
      a={
        <IconTile>
          <Siren className={cn(ic, 'text-red-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'incident-postmortem': () => (
    <DuoCover
      a={
        <IconTile>
          <ClipboardList className={cn(ic, 'text-orange-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'lead-follow-up': () => (
    <FeatureCover glow="bg-orange-500/15">
      <UserPlus className={cn(big, 'text-orange-500')} />
    </FeatureCover>
  ),
  'crm-hygiene': () => (
    <FeatureCover glow="bg-fuchsia-500/15">
      <Users className={cn(big, 'text-fuchsia-500')} />
    </FeatureCover>
  ),
  'expense-reconciliation': () => (
    <FeatureCover glow="bg-emerald-500/15">
      <Receipt className={cn(big, 'text-emerald-500')} />
    </FeatureCover>
  ),
  'competitor-watch': () => (
    <FeatureCover glow="bg-cyan-500/15">
      <Radar className={cn(big, 'text-cyan-500')} />
    </FeatureCover>
  ),
  'compliance-monitoring': () => (
    <FeatureCover glow="bg-teal-500/15">
      <ShieldCheck className={cn(big, 'text-teal-500')} />
    </FeatureCover>
  ),
  'contract-review': () => (
    <FeatureCover glow="bg-violet-500/15">
      <ScrollText className={cn(big, 'text-violet-500')} />
    </FeatureCover>
  ),
  'ar-chaser': () => (
    <FeatureCover glow="bg-green-500/15">
      <CircleDollarSign className={cn(big, 'text-green-500')} />
    </FeatureCover>
  ),
  'investor-update': () => (
    <FeatureCover glow="bg-blue-500/15">
      <TrendingUp className={cn(big, 'text-blue-500')} />
    </FeatureCover>
  ),
  'security-questionnaire': () => (
    <DuoCover
      a={
        <IconTile>
          <ClipboardCheck className={cn(ic, 'text-blue-500')} />
        </IconTile>
      }
      b={<Slack />}
    />
  ),
  'sales-call-followup': () => (
    <DuoCover
      a={
        <IconTile>
          <PhoneCall className={cn(ic, 'text-emerald-500')} />
        </IconTile>
      }
      b={<Linear />}
    />
  ),
  'outbound-outreach': () => (
    <FeatureCover glow="bg-sky-500/15">
      <Send className={cn(big, 'text-sky-500')} />
    </FeatureCover>
  ),
  'resume-triage': () => (
    <FeatureCover glow="bg-violet-500/15">
      <UserSearch className={cn(big, 'text-violet-500')} />
    </FeatureCover>
  ),
  'employee-offboarding': () => (
    <DuoCover
      a={
        <IconTile>
          <UserMinus className={cn(ic, 'text-red-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'churn-risk': () => (
    <DuoCover
      a={
        <IconTile>
          <TrendingDown className={cn(ic, 'text-rose-500')} />
        </IconTile>
      }
      b={<Slack />}
    />
  ),
  'user-feedback': () => (
    <DuoCover
      a={
        <IconTile>
          <MessagesSquare className={cn(ic, 'text-fuchsia-500')} />
        </IconTile>
      }
      b={<Linear />}
    />
  ),
};
