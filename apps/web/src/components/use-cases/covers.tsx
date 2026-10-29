import { useTranslations } from '@/i18n/use-translations';
/* eslint-disable @next/next/no-img-element */
import {
  ActivityIcon as Activity,
  AlarmIcon as AlarmClock,
  AtIcon as AtSign,
  ChartBarIcon as BarChart3,
  BugIcon as Bug,
  CalculatorIcon as Calculator,
  CalendarDotsIcon as CalendarClock,
  CalendarPlusIcon as CalendarPlus,
  CheckCircleIcon as CheckCircle2,
  CurrencyCircleDollarIcon as CircleDollarSign,
  ListChecksIcon as ClipboardCheck,
  ClipboardTextIcon as ClipboardList,
  CloudIcon as Cloud,
  CoffeeIcon as Coffee,
  CreditCardIcon as CreditCard,
  DatabaseIcon as Database,
  FileLockIcon as FileLock2,
  FilesIcon as Files,
  FileSearchIcon as FileSearch,
  SignatureIcon as FileSignature,
  FileTextIcon as FileText,
  FunnelIcon as Filter,
  FlagIcon as Flag,
  FlaskIcon as FlaskConical,
  GaugeIcon as Gauge,
  GitMergeIcon as GitMerge,
  GitPullRequestIcon as GitPullRequest,
  HandshakeIcon as Handshake,
  QuestionIcon as HelpCircle,
  KeyIcon as KeyRound,
  ChartLineIcon as LineChart,
  EnvelopeIcon as Mail,
  ChatsIcon as MessagesSquare,
  PhoneCallIcon as PhoneCall,
  PresentationIcon as Presentation,
  BroadcastIcon as Radar,
  ReceiptIcon as Receipt,
  ArrowClockwiseIcon as RefreshCw,
  RepeatIcon as Repeat,
  RocketIcon as Rocket,
  PathIcon as Route,
  ScalesIcon as Scale,
  ScrollIcon as ScrollText,
  PaperPlaneTiltIcon as Send,
  ShareNetworkIcon as Share2,
  ShieldWarningIcon as ShieldAlert,
  ShieldCheckIcon as ShieldCheck,
  SirenIcon as Siren,
  TagIcon as Tag,
  TargetIcon as Target,
  TicketIcon as Ticket,
  TrendDownIcon as TrendingDown,
  TrendUpIcon as TrendingUp,
  WarningIcon as TriangleAlert,
  UserMinusIcon as UserMinus,
  UserPlusIcon as UserPlus,
  UserFocusIcon as UserRoundSearch,
  UsersIcon as Users,
  UserFocusIcon as UserSearch,
  WalletIcon as Wallet,
} from '@/lib/icons/ssr';
import type { ComponentType, ReactNode } from 'react';

import type { Post } from '@/lib/blog';
import { cn } from '@kortix/ui';

export type UseCaseCoverProps = { post: Post; featured?: boolean };

// ── shared surface + building blocks ────────────────────────────────────────

// The pixel field (Paper "Use-case covers · 20 Pixel field"): a sparse 24px
// grid of 3px squares, a few darker, faded out around the centre so the logo
// tiles sit on clear ground. The squares are masks over `bg-foreground`, so
// they follow the theme.
const PIXELS_LIGHT = `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><rect x='10' y='10' width='3' height='3'/><rect x='34' y='10' width='3' height='3'/><rect x='82' y='10' width='3' height='3'/><rect x='130' y='10' width='3' height='3'/><rect x='154' y='10' width='3' height='3'/><rect x='202' y='10' width='3' height='3'/><rect x='10' y='34' width='3' height='3'/><rect x='34' y='34' width='3' height='3'/><rect x='106' y='34' width='3' height='3'/><rect x='130' y='34' width='3' height='3'/><rect x='226' y='34' width='3' height='3'/><rect x='34' y='58' width='3' height='3'/><rect x='82' y='58' width='3' height='3'/><rect x='106' y='58' width='3' height='3'/><rect x='130' y='58' width='3' height='3'/><rect x='154' y='58' width='3' height='3'/><rect x='202' y='58' width='3' height='3'/><rect x='34' y='82' width='3' height='3'/><rect x='82' y='82' width='3' height='3'/><rect x='106' y='82' width='3' height='3'/><rect x='130' y='82' width='3' height='3'/><rect x='202' y='82' width='3' height='3'/><rect x='34' y='106' width='3' height='3'/><rect x='106' y='106' width='3' height='3'/><rect x='226' y='106' width='3' height='3'/><rect x='34' y='130' width='3' height='3'/><rect x='58' y='130' width='3' height='3'/><rect x='106' y='130' width='3' height='3'/><rect x='154' y='130' width='3' height='3'/><rect x='34' y='154' width='3' height='3'/><rect x='10' y='178' width='3' height='3'/><rect x='130' y='178' width='3' height='3'/><rect x='154' y='178' width='3' height='3'/><rect x='202' y='178' width='3' height='3'/><rect x='10' y='202' width='3' height='3'/><rect x='34' y='202' width='3' height='3'/><rect x='58' y='202' width='3' height='3'/><rect x='106' y='202' width='3' height='3'/><rect x='130' y='202' width='3' height='3'/><rect x='154' y='202' width='3' height='3'/><rect x='202' y='202' width='3' height='3'/><rect x='106' y='226' width='3' height='3'/><rect x='130' y='226' width='3' height='3'/><rect x='154' y='226' width='3' height='3'/><rect x='226' y='226' width='3' height='3'/></svg>")`;
const PIXELS_DARK = `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><rect x='154' y='10' width='3' height='3'/><rect x='130' y='34' width='3' height='3'/><rect x='106' y='58' width='3' height='3'/><rect x='130' y='58' width='3' height='3'/><rect x='226' y='58' width='3' height='3'/><rect x='10' y='82' width='3' height='3'/><rect x='106' y='82' width='3' height='3'/><rect x='58' y='130' width='3' height='3'/><rect x='178' y='130' width='3' height='3'/><rect x='226' y='178' width='3' height='3'/><rect x='10' y='202' width='3' height='3'/></svg>")`;
const CLEAR_CENTRE = 'radial-gradient(ellipse 34% 46% at 50% 50%, transparent 55%, #000 100%)';

function PixelLayer({ pixels, className }: { pixels: string; className: string }) {
  return (
    <div
      aria-hidden
      className={cn('bg-foreground absolute inset-0', className)}
      style={{ maskImage: pixels, WebkitMaskImage: pixels, maskSize: '240px', WebkitMaskSize: '240px' }}
    />
  );
}

function CoverBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background absolute inset-0 overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ maskImage: CLEAR_CENTRE, WebkitMaskImage: CLEAR_CENTRE }}
      >
        <PixelLayer pixels={PIXELS_LIGHT} className="opacity-15" />
        <PixelLayer pixels={PIXELS_DARK} className="opacity-40" />
      </div>
      {children}
    </div>
  );
}

const TILE =
  'border-border relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border sm:size-14';
const ROW =
  'absolute inset-0 flex items-center justify-center gap-3 transition-transform duration-slow ease-out group-hover:scale-[1.03] sm:gap-4';
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
      <div className={ROW}>{children}</div>
    </CoverBackdrop>
  );
}

function DuoCover({ a, b }: { a: ReactNode; b: ReactNode }) {
  return (
    <CoverBackdrop>
      <div className="absolute inset-0 flex items-center justify-center gap-3 transition-transform duration-slow ease-out group-hover:scale-[1.03] sm:gap-4">
        {a}
        <span className="text-muted-foreground/40 text-lg font-light">×</span>
        {b}
      </div>
    </CoverBackdrop>
  );
}

// `glow` is kept for the registry entries that pass it; the pixel field has no glow.
function FeatureCover({ children }: { children: ReactNode; glow?: string }) {
  return (
    <CoverBackdrop>
      <div className="absolute inset-0 flex items-center justify-center transition-transform duration-slow ease-out group-hover:scale-[1.03]">
        <div className="bg-card border-border flex size-16 items-center justify-center rounded-md border sm:size-20">
          {children}
        </div>
      </div>
    </CoverBackdrop>
  );
}

function HeroCover({ children }: { children: ReactNode }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <CoverBackdrop>
      <div className="absolute inset-0 flex items-center justify-center transition-transform duration-slow ease-out group-hover:scale-[1.03]">
        <div className="relative">
          <div className="border-border grid size-16 place-items-center rounded-md border bg-white sm:size-20">
            {children}
          </div>
          <div className="border-border absolute -right-1.5 -bottom-1.5 overflow-hidden rounded-sm border bg-white">
            <img
              src="/usecases/logos/kortix.png"
              alt={tI18nComplete.raw('textab54cf5e1d9d')}
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
      {satellites.map((node, i) => {
        const angle = (i / satellites.length) * 360 + 45;
        return (
          <div
            key={i}
            className="absolute top-1/2 left-1/2"
            style={{
              transform: `translate(-50%,-50%) rotate(${angle}deg) translate(84px) rotate(${-angle}deg)`,
            }}
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
      <img
        src="/usecases/logos/github.svg"
        alt="GitHub"
        className="size-9 object-contain sm:size-11"
      />
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
  // ── business-function batch ────────────────────────────────────────────────
  'payment-recovery': () => (
    <RowCover>
      <IconTile>
        <CreditCard className={cn(ic, 'text-rose-500')} />
      </IconTile>
      <Kortix />
      <div className={cn(TILE, 'bg-emerald-500 text-white')}>
        <CircleDollarSign className={ic} />
      </div>
    </RowCover>
  ),
  'ap-invoice-processing': () => (
    <DuoCover
      a={
        <IconTile>
          <Files className={cn(ic, 'text-amber-500')} />
        </IconTile>
      }
      b={<Slack />}
    />
  ),
  'saas-spend-audit': () => (
    <FeatureCover glow="bg-lime-500/15">
      <Wallet className={cn(big, 'text-lime-600')} />
    </FeatureCover>
  ),
  'renewal-manager': () => (
    <FeatureCover glow="bg-indigo-500/15">
      <Repeat className={cn(big, 'text-indigo-500')} />
    </FeatureCover>
  ),
  'rfp-responder': () => (
    <FeatureCover glow="bg-purple-500/15">
      <FileSignature className={cn(big, 'text-purple-500')} />
    </FeatureCover>
  ),
  'pipeline-hygiene': () => (
    <FeatureCover glow="bg-pink-500/15">
      <Filter className={cn(big, 'text-pink-500')} />
    </FeatureCover>
  ),
  'content-refresh': () => (
    <DuoCover
      a={
        <IconTile>
          <RefreshCw className={cn(ic, 'text-orange-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'ad-performance': () => (
    <FeatureCover glow="bg-rose-500/15">
      <Target className={cn(big, 'text-rose-500')} />
    </FeatureCover>
  ),
  'qbr-prep': () => (
    <FeatureCover glow="bg-blue-500/15">
      <Presentation className={cn(big, 'text-blue-500')} />
    </FeatureCover>
  ),
  'customer-onboarding': () => (
    <FeatureCover glow="bg-sky-500/15">
      <Rocket className={cn(big, 'text-sky-500')} />
    </FeatureCover>
  ),
  'data-pipeline-monitor': () => (
    <DuoCover
      a={
        <IconTile>
          <Activity className={cn(ic, 'text-cyan-500')} />
        </IconTile>
      }
      b={
        <IconTile>
          <Database className={cn(ic, 'text-foreground/70')} />
        </IconTile>
      }
    />
  ),
  'candidate-sourcing': () => (
    <FeatureCover glow="bg-violet-500/15">
      <UserRoundSearch className={cn(big, 'text-violet-500')} />
    </FeatureCover>
  ),
  // ── use-case-max batch ─────────────────────────────────────────────────────
  'pr-review-nudge': () => (
    <DuoCover
      a={
        <IconTile>
          <AlarmClock className={cn(ic, 'text-amber-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'error-triage': () => (
    <DuoCover
      a={
        <IconTile>
          <Bug className={cn(ic, 'text-red-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'flaky-test-triage': () => (
    <FeatureCover glow="bg-yellow-500/15">
      <FlaskConical className={cn(big, 'text-yellow-500')} />
    </FeatureCover>
  ),
  'cloud-cost-anomaly': () => (
    <FeatureCover glow="bg-amber-500/15">
      <Cloud className={cn(big, 'text-amber-500')} />
    </FeatureCover>
  ),
  'feature-flag-cleanup': () => (
    <FeatureCover glow="bg-orange-500/15">
      <Flag className={cn(big, 'text-orange-500')} />
    </FeatureCover>
  ),
  'lead-routing': () => (
    <FeatureCover glow="bg-blue-500/15">
      <Route className={cn(big, 'text-blue-500')} />
    </FeatureCover>
  ),
  'sales-forecast': () => (
    <FeatureCover glow="bg-emerald-500/15">
      <LineChart className={cn(big, 'text-emerald-500')} />
    </FeatureCover>
  ),
  'win-loss-analysis': () => (
    <FeatureCover glow="bg-violet-500/15">
      <Scale className={cn(big, 'text-violet-500')} />
    </FeatureCover>
  ),
  'social-scheduler': () => (
    <FeatureCover glow="bg-pink-500/15">
      <Share2 className={cn(big, 'text-pink-500')} />
    </FeatureCover>
  ),
  'brand-monitor': () => (
    <FeatureCover glow="bg-fuchsia-500/15">
      <AtSign className={cn(big, 'text-fuchsia-500')} />
    </FeatureCover>
  ),
  'nps-analysis': () => (
    <FeatureCover glow="bg-cyan-500/15">
      <Gauge className={cn(big, 'text-cyan-500')} />
    </FeatureCover>
  ),
  'ticket-to-kb': () => (
    <DuoCover
      a={
        <IconTile>
          <Ticket className={cn(ic, 'text-sky-500')} />
        </IconTile>
      }
      b={<GitHub />}
    />
  ),
  'escalation-manager': () => (
    <FeatureCover glow="bg-rose-500/15">
      <TriangleAlert className={cn(big, 'text-rose-500')} />
    </FeatureCover>
  ),
  'month-end-close': () => (
    <FeatureCover glow="bg-teal-500/15">
      <Calculator className={cn(big, 'text-teal-500')} />
    </FeatureCover>
  ),
  'vendor-onboarding': () => (
    <FeatureCover glow="bg-indigo-500/15">
      <Handshake className={cn(big, 'text-indigo-500')} />
    </FeatureCover>
  ),
  'interview-scheduler': () => (
    <FeatureCover glow="bg-purple-500/15">
      <CalendarPlus className={cn(big, 'text-purple-500')} />
    </FeatureCover>
  ),
  'hr-policy-qa': () => (
    <FeatureCover glow="bg-sky-500/15">
      <HelpCircle className={cn(big, 'text-sky-500')} />
    </FeatureCover>
  ),
  'nda-turnaround': () => (
    <FeatureCover glow="bg-green-500/15">
      <FileLock2 className={cn(big, 'text-green-600')} />
    </FeatureCover>
  ),
  'gdpr-dsar': () => (
    <FeatureCover glow="bg-blue-500/15">
      <FileSearch className={cn(big, 'text-blue-500')} />
    </FeatureCover>
  ),
  'phishing-triage': () => (
    <DuoCover
      a={
        <IconTile>
          <ShieldAlert className={cn(ic, 'text-red-500')} />
        </IconTile>
      }
      b={<Slack />}
    />
  ),
};
