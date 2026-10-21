import { BrandGlyph, Wordmark } from '@/components/brand-mark';
import { cn } from '@kortix/ui';
import {
  ArrowUpIcon,
  BooksIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  ClockIcon,
  FileDocIcon,
  FilePdfIcon,
  FolderSimpleIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  NotePencilIcon,
  PaperclipIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  TableIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { MockName } from './content';
import { Diamond } from './parts';

// Product moments for the public site: static renders that use the app's own
// tokens and the synthetic dataset (demo-data/: Project Aster). Every clause
// number and quote is real text from demo-data/src; change the dataset, change these.

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div aria-hidden className={cn('rounded-[10px] border border-border bg-card text-[13px] leading-snug text-foreground shadow-lg', className)}>
      {children}
    </div>
  );
}

/** A book-spine tile: Lumen's avatar for a workflow. */
export function Spine({ letter, tone, className }: { letter: string; tone: 'navy' | 'oxblood' | 'sand' | 'slate' | 'moss'; className?: string }) {
  const tones = {
    navy: 'from-[#183250] to-[#0a1828] text-[#F5F3EF]',
    oxblood: 'from-[#5a2328] to-[#3a1519] text-[#F5F3EF]',
    sand: 'from-[#E4D8C2] to-[#CDBB9A] text-[#3A3A38]',
    slate: 'from-[#7C8796] to-[#566170] text-[#F5F3EF]',
    moss: 'from-[#3E5A4C] to-[#253A30] text-[#F5F3EF]',
  } as const;
  return (
    <span className={cn('grid size-6 shrink-0 place-items-center rounded-[4px] bg-gradient-to-b font-display text-[13px] leading-none', tones[tone], className)}>
      {letter}
    </span>
  );
}

const Chip = ({ n, muted }: { n: number; muted?: boolean }) => (
  <span
    className={cn(
      'mx-0.5 inline-grid h-[15px] min-w-[15px] place-items-center rounded-[3px] border px-[3px] align-[1px] font-mono text-[9.5px] leading-none',
      muted ? 'border-dashed border-border text-muted-foreground line-through' : 'border-verified/30 bg-paper text-foreground',
    )}
  >
    {n}
  </span>
);

function Composer({ text, mention }: { text: string; mention?: string }) {
  return (
    <Card className="p-4">
      <p className="min-h-10 text-[14px]">
        {text}
        {mention && <span className="ml-1 rounded-[3px] bg-navy/10 px-1 py-px text-navy dark:bg-white/10 dark:text-white">{mention}</span>}
        <span className="ml-px inline-block h-4 w-px translate-y-[3px] bg-foreground" />
      </p>
      <div className="mt-3 flex items-center gap-2 text-muted-foreground">
        <span className="grid size-7 place-items-center rounded-full bg-foreground/[0.05]">
          <PlusIcon className="size-3.5" />
        </span>
        <PaperclipIcon className="size-4" />
        <SlidersHorizontalIcon className="size-4" />
        <span className="flex-1" />
        <MicrophoneIcon className="size-4" />
        <span className="grid size-7 place-items-center rounded-[6px] bg-navy text-white dark:bg-[#F5F3EF] dark:text-navy">
          <ArrowUpIcon className="size-3.5" weight="bold" />
        </span>
      </div>
    </Card>
  );
}

const WORKFLOWS = [
  ['N', 'navy', 'NDA review against playbook'],
  ['D', 'oxblood', 'Due diligence report'],
  ['C', 'sand', 'Chronology from a bundle'],
  ['T', 'slate', 'Draft from template'],
  ['O', 'moss', 'Obligations register'],
] as const;

function ComposerMock() {
  return (
    <div className="relative">
      <Composer text="For Project Aster, run the" mention="/dilig" />
      <Card className="absolute top-[58px] right-[-8px] w-[64%] min-w-[220px] p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">Workflows</p>
        {WORKFLOWS.map(([l, t, name], i) => (
          <div key={name} className={cn('flex items-center gap-2.5 rounded-[6px] px-2 py-1.5', i === 1 && 'bg-foreground/[0.05]')}>
            <Spine letter={l} tone={t} />
            <span className="truncate">{name}</span>
          </div>
        ))}
      </Card>
      <div className="h-[200px]" />
    </div>
  );
}

function AnswerMock() {
  return (
    <Card className="p-4">
      <div className="ml-auto w-fit max-w-[85%] rounded-[8px] bg-foreground/[0.05] px-3 py-2">Which agreements leave liability uncapped?</div>
      <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <BrandGlyph className="size-3.5 text-foreground" />
        Read 6 documents · 4 steps
        <CaretDownIcon className="size-3" />
      </div>
      <p className="mt-2 font-display text-[15px] leading-[1.45] [font-variation-settings:'opsz'_16]">
        One agreement leaves liability uncapped: the master services agreement with Quillon Analytics. Clause 11.1 excludes any limit for
        either party
        <Chip n={1} />. The SaaS agreement caps liability at twelve months of fees
        <Chip n={2} />.
      </p>
      <div className="mt-3 rounded-[6px] border border-border bg-paper/60 p-3">
        <p className="font-mono text-[10.5px] text-muted-foreground">
          [1] msa-brightwater-quillon.pdf · p. 2 · ¶ 11.1 <span className="text-verified">· verified</span>
        </p>
        <p className="mt-1.5 border-l-2 border-navy pl-2 font-display text-[13.5px] leading-snug dark:border-white/60">
          Neither party’s liability under or in connection with this Agreement …{' '}
          <mark className="bg-lamp/25 text-foreground">shall be limited or capped in amount</mark>.
        </p>
      </div>
    </Card>
  );
}

function QuestionMock() {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <BrandGlyph className="size-3.5 text-foreground" /> Needs your input
      </p>
      <p className="mt-2 text-[14px] font-medium">Which side does the firm act for in Project Aster?</p>
      <div className="mt-3 space-y-1.5">
        {['Buyer: Brightwater Holdings', 'Seller: Aster Group', 'Neither: a neutral summary'].map((o, i) => (
          <div key={o} className={cn('flex items-center gap-2.5 rounded-[6px] border px-3 py-2', i === 0 ? 'border-navy/40 bg-navy/[0.04] dark:border-white/40' : 'border-border')}>
            <span className="font-mono text-[11px] text-muted-foreground">{i + 1}</span>
            {o}
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2 text-[12px]">
        <span className="rounded-full px-3 py-1 text-muted-foreground">Skip</span>
        <span className="rounded-full bg-navy px-3 py-1 text-white dark:bg-[#F5F3EF] dark:text-navy">Confirm</span>
      </div>
    </Card>
  );
}

function SandboxMock() {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11.5px] text-muted-foreground">
        <TerminalWindowIcon className="size-3.5" /> Isolated workspace · this conversation only
      </div>
      <div className="space-y-1.5 p-3 font-mono text-[11px] leading-relaxed">
        <p className="text-muted-foreground">$ ocr spa-excerpt-aster.pdf --pages 1-2</p>
        <p>2 pages · 1,184 words · 0 unreadable</p>
        <p className="text-muted-foreground">$ diff lease-v1.docx lease-v2.docx</p>
        <p>
          <span className="text-risk">− 5% annual increase</span>
        </p>
        <p>
          <span className="text-verified">+ 8% annual increase</span> <span className="text-muted-foreground">(cl. 4.2)</span>
        </p>
        <p className="text-muted-foreground">$ notice-period --from 2026-10-21 --months 6</p>
        <p>Last day to serve notice: 21 April 2027</p>
      </div>
    </Card>
  );
}

const DOCS = [
  ['msa-brightwater-quillon.pdf', 'pdf', 'V2', '3 pp'],
  ['saas-agreement-lattice.docx', 'doc', 'V1', '9 KB'],
  ['supply-agreement-meridian.pdf', 'pdf', 'V1', '2 pp'],
  ['spa-excerpt-aster.pdf', 'pdf', 'V3', '2 pp'],
  ['office-lease-cedar-row.pdf', 'pdf', 'V1', '2 pp'],
] as const;

function VaultMock() {
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-muted-foreground">
        <MagnifyingGlassIcon className="size-3.5" />
        <span className="text-foreground">change of control</span>
        <span className="ml-auto font-mono text-[10.5px]">3 docs · 4 pages</span>
      </div>
      <div className="divide-y divide-border">
        {DOCS.map(([n, t, v, s]) => (
          <div key={n} className="flex items-center gap-2.5 px-1 py-2">
            {t === 'pdf' ? <FilePdfIcon className="size-4 text-risk/80" /> : <FileDocIcon className="size-4 text-navy dark:text-[#8FA5BF]" />}
            <span className="min-w-0 flex-1 truncate">{n}</span>
            <span className="rounded-[3px] bg-foreground/[0.05] px-1.5 font-mono text-[10px]">{v}</span>
            <span className="w-10 text-right font-mono text-[10.5px] text-muted-foreground">{s}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function VersionsMock() {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <FileDocIcon className="size-4" />
        <span className="font-medium">spa-excerpt-aster.docx</span>
        <span className="ml-auto flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
          V3 <CaretDownIcon className="size-3" />
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {[
          ['V3', 'Drafted by Lumen from the agreed terms', 'Today'],
          ['V2', 'Counterparty turn, uploaded by J. Ames', 'Oct 18'],
          ['V1', 'Seller’s first draft', 'Oct 9'],
        ].map(([v, d, w], i) => (
          <div key={v} className="flex items-start gap-3">
            <span className={cn('mt-1 size-2 rounded-full', i === 0 ? 'bg-lamp' : 'bg-border')} />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px]">
                <span className="font-mono text-[11px]">{v}</span> · {d}
              </p>
              <p className="text-[11px] text-muted-foreground">{w}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const GRID = [
  ['MSA · Quillon', 'Uncapped', 'red', 'New York', 'Consent'],
  ['SaaS · Lattice', '12 months’ fees', 'green', 'England and Wales', 'Consent'],
  ['Supply · Meridian', 'GBP 2,000,000 / yr', 'green', 'England and Wales', 'Notice'],
  ['Lease · Cedar Row', 'Not stated', 'grey', 'England and Wales', 'Consent'],
  ['SPA · Aster', 'Purchase price', 'yellow', 'England and Wales', '—'],
] as const;

const DOT = { red: 'bg-risk', green: 'bg-verified', yellow: 'bg-lamp', grey: 'bg-muted-foreground/40' } as const;

function ReviewMock() {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11.5px]">
        <TableIcon className="size-3.5" />
        <span className="font-medium">Project Aster · Key terms</span>
        <span className="ml-auto rounded-full bg-navy px-2 py-0.5 text-[10.5px] text-white dark:bg-[#F5F3EF] dark:text-navy">Run</span>
      </div>
      <table className="w-full text-left text-[11.5px]">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1.5 pr-2 pl-3 font-normal">Document</th>
            <th className="py-1.5 pr-2 font-normal">Liability cap</th>
            <th className="hidden py-1.5 pr-2 font-normal sm:table-cell">Governing law</th>
            <th className="py-1.5 pr-3 font-normal">Assignment</th>
          </tr>
        </thead>
        <tbody>
          {GRID.map((r) => (
            <tr key={r[0]} className="border-b border-border/70 last:border-0">
              <td className="py-2 pr-2 pl-3 font-medium whitespace-nowrap">{r[0]}</td>
              <td className="relative py-2 pr-4">
                <span className="line-clamp-1">{r[1]}</span>
                <span className={cn('absolute top-2 right-1.5 size-1.5 rounded-full', DOT[r[2]])} />
              </td>
              <td className="hidden py-2 pr-2 sm:table-cell">{r[3]}</td>
              <td className="py-2 pr-3">
                <span className="rounded-full bg-foreground/[0.05] px-1.5 py-0.5 text-[10.5px]">{r[4]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CellMock() {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        MSA · Quillon <CaretRightIcon className="size-3" /> Liability cap
        <span className="ml-auto flex items-center gap-1 rounded-full bg-risk/10 px-2 py-0.5 text-risk">
          <Diamond className="size-[5px]" /> High
        </span>
      </div>
      <p className="mt-2 font-display text-[18px] tracking-[-0.01em]">Uncapped</p>
      <p className="mt-1 text-muted-foreground">Clause 11.1 excludes any limit on either party’s liability.</p>
      <div className="mt-3 rounded-[6px] border border-border bg-paper/60 p-2.5 font-display text-[13px] leading-snug">
        “…<mark className="bg-lamp/25 text-foreground">shall be limited or capped in amount</mark>.” <Chip n={1} />
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11.5px]">
        <span className="flex items-center gap-1 rounded-full border border-verified/40 px-2 py-0.5 text-verified">
          <CheckIcon className="size-3" weight="bold" /> Verified by J. Ames
        </span>
        <span className="ml-auto font-mono text-muted-foreground">↑ ↓ ← →</span>
      </div>
    </Card>
  );
}

function WorkflowListMock() {
  return (
    <Card className="p-1.5">
      <div className="flex gap-1 px-1.5 pt-1.5 pb-2 text-[11.5px]">
        {['All', 'Assistant', 'Review', 'Firm'].map((t, i) => (
          <span key={t} className={cn('rounded-full px-2.5 py-1', i === 0 ? 'bg-foreground text-background' : 'text-muted-foreground')}>
            {t}
          </span>
        ))}
      </div>
      {WORKFLOWS.map(([l, t, name], i) => (
        <div key={name} className="flex items-center gap-2.5 border-t border-border px-2 py-2">
          <Spine letter={l} tone={t} />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">{i % 2 ? 'Review' : 'Assistant'}</span>
          <span className="text-[11px] text-muted-foreground">{i < 2 ? 'Firm' : 'Private'}</span>
        </div>
      ))}
    </Card>
  );
}

function PlaybookMock() {
  return (
    <Card className="p-4">
      <div className="mb-3 flex gap-1.5 text-[11px]">
        <span className="rounded-full bg-risk/10 px-2 py-0.5 text-risk">2 High</span>
        <span className="rounded-full bg-flag/15 px-2 py-0.5">1 Medium</span>
        <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5">8 Aligned</span>
      </div>
      <p className="font-medium">NDA-01 · Confidentiality term exceeds playbook</p>
      <p className="mt-0.5 text-muted-foreground">Seven years; the playbook allows at most three.</p>
      <p className="mt-2.5 rounded-[6px] bg-paper/80 px-2.5 py-2 font-display text-[13.5px] leading-snug">
        …shall survive for a period of <del className="text-risk decoration-risk/60">seven (7)</del>{' '}
        <ins className="bg-verified/15 text-foreground no-underline">three (3)</ins> years…
      </p>
      <div className="mt-3 flex gap-2 text-[11.5px]">
        <span className="rounded-full bg-navy px-2.5 py-1 text-white dark:bg-[#F5F3EF] dark:text-navy">Accept</span>
        <span className="rounded-full border border-border px-2.5 py-1">Dismiss</span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          <FileDocIcon className="size-3.5" /> redline.docx
        </span>
      </div>
    </Card>
  );
}

function DiligenceMock() {
  return (
    <Card className="p-4">
      <p className="font-display text-[17px] tracking-[-0.01em]">Project Aster · Due diligence</p>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">6 documents · 8 sections · every finding cited</p>
      <div className="mt-3 space-y-2">
        {[
          ['risk', 'Uncapped liability in the Quillon MSA', 1],
          ['risk', 'Change of control terminates the SPA consent', 2],
          ['flag', 'Lease rent rises 8% a year, structural repairs on tenant', 3],
          ['flag', 'Exclusive supply to Meridian until 2029', 4],
        ].map(([t, title, n]) => (
          <div key={String(title)} className="flex items-start gap-2.5">
            <Diamond className={cn('mt-1.5', t === 'risk' ? 'text-risk' : 'text-flag')} />
            <p className="min-w-0 flex-1">
              {title}
              <Chip n={Number(n)} />
            </p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
        <span className="flex gap-0.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="h-1.5 w-4 rounded-full bg-verified/70" />
          ))}
        </span>
        6 of 6 batches · 2 m 48 s
      </div>
    </Card>
  );
}

function RedlineMock() {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground">B</span>
        <span className="italic">I</span>
        <span className="underline">U</span>
        <span className="h-3 w-px bg-border" />
        <span>Track changes</span>
        <span className="ml-auto flex items-center gap-1">
          Editing <CaretDownIcon className="size-3" />
        </span>
      </div>
      <div className="space-y-2 px-5 py-4 font-display text-[13.5px] leading-[1.55]">
        <p className="text-[11px] tracking-[0.12em] uppercase">7. Term and survival</p>
        <p>
          7.1 The obligations in this Agreement shall survive for a period of{' '}
          <del className="text-risk decoration-risk/60">seven (7)</del> <ins className="text-verified underline decoration-verified/50">three (3)</ins> years from
          the date of disclosure.
        </p>
        <p className="relative">
          7.2 Trade secrets remain confidential for so long as they remain trade secrets.
          <span className="absolute top-0 -right-3 h-full w-[2px] bg-lamp" />
        </p>
      </div>
      <div className="mx-3 mb-3 rounded-[6px] border border-lamp/40 bg-lamp/10 px-2.5 py-1.5 text-[11.5px]">
        <span className="font-medium">Comment · Lumen</span> Playbook NDA-01: term limited to three years.
      </div>
    </Card>
  );
}

function DraftMock() {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <FileDocIcon className="size-4" />
        <span className="font-medium">mutual-nda-draft.docx</span>
        <span className="rounded-[3px] bg-foreground/[0.05] px-1.5 font-mono text-[10px]">V1</span>
      </div>
      <div className="mt-3 space-y-1.5 font-display text-[13.5px] leading-[1.5]">
        <p>
          This Agreement is made on <span className="bg-verified/12 px-0.5">21 October 2026</span> between{' '}
          <span className="bg-verified/12 px-0.5">Brightwater Holdings Ltd</span> and{' '}
          <span className="bg-verified/12 px-0.5">Quillon Analytics Inc.</span>
        </p>
        <p>
          This Agreement is governed by the laws of{' '}
          <span className="rounded-[3px] border border-dashed border-lamp px-1 font-mono text-[11px] text-foreground">[[CONFIRM: governing law]]</span>.
        </p>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Diamond className="text-lamp" /> 1 fact left for a lawyer to confirm
      </p>
    </Card>
  );
}

function OversightMock() {
  const bars = [32, 44, 38, 56, 61, 48, 72, 66, 80, 74, 88, 92];
  return (
    <Card className="p-4">
      <p className="font-display text-[17px] tracking-[-0.01em]">Usage</p>
      <div className="mt-1 flex gap-4 border-b border-border text-[11.5px]">
        {['Matters', 'Members', 'Runs'].map((t, i) => (
          <span key={t} className={cn('-mb-px border-b-2 pb-1.5', i === 0 ? 'border-navy dark:border-white' : 'border-transparent text-muted-foreground')}>
            {t}
          </span>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          ['Questions', '1,284'],
          ['Runs', '96'],
          ['Members', '14'],
        ].map(([l, v]) => (
          <div key={l} className="rounded-[6px] border border-border p-2">
            <p className="text-[10.5px] text-muted-foreground">{l}</p>
            <p className="font-display text-[18px] tracking-[-0.02em]">{v}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex h-20 items-end gap-1">
        {bars.map((h, i) => (
          <span
            key={i}
            className={cn('flex-1 rounded-t-[2px]', i > 9 ? 'bg-[repeating-linear-gradient(135deg,var(--brand)_0_2px,transparent_2px_5px)] opacity-60' : 'bg-navy/80 dark:bg-[#8FA5BF]')}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </Card>
  );
}

function AuditMock() {
  return (
    <Card className="p-1.5">
      {[
        ['matter.create', 'Project Aster', '09:12'],
        ['document.upload', '6 documents', '09:14'],
        ['run.start', 'Due diligence', '09:15'],
        ['cell.verify', 'MSA · Liability cap', '11:02'],
        ['export.docx', 'redline.docx', '11:40'],
      ].map(([a, d, t]) => (
        <div key={a} className="flex items-center gap-3 border-b border-border px-2 py-2 last:border-0">
          <span className="w-28 shrink-0 font-mono text-[10.5px] text-muted-foreground">{a}</span>
          <span className="min-w-0 flex-1 truncate">{d}</span>
          <span className="font-mono text-[10.5px] text-muted-foreground">{t}</span>
        </div>
      ))}
    </Card>
  );
}

function RolesMock() {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 font-medium">
        Project Aster <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[10.5px] font-normal">Restricted</span>
      </p>
      <div className="mt-3 divide-y divide-border">
        {[
          ['JA', 'J. Ames', 'Owner'],
          ['RK', 'R. Kaur', 'Admin'],
          ['TL', 'T. Lindqvist', 'Lawyer'],
        ].map(([i, n, r]) => (
          <div key={n} className="flex items-center gap-2.5 py-2">
            <span className="grid size-6 place-items-center rounded-full bg-paper font-mono text-[10px]">{i}</span>
            <span className="flex-1">{n}</span>
            <span className="text-[11.5px] text-muted-foreground">{r}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MatterMock() {
  return (
    <Card className="p-4">
      <p className="text-[11px] text-muted-foreground">Matters / Project Aster</p>
      <p className="font-display text-[19px] tracking-[-0.02em]">Project Aster</p>
      <div className="mt-2 flex gap-4 border-b border-border text-[11.5px]">
        {['Documents', 'Chats', 'Reviews'].map((t, i) => (
          <span key={t} className={cn('-mb-px border-b-2 pb-1.5', i === 0 ? 'border-navy dark:border-white' : 'border-transparent text-muted-foreground')}>
            {t}
          </span>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {['Contracts', 'Corporate', 'Property'].map((f, i) => (
          <div key={f} className="rounded-[6px] border border-border p-2.5">
            <FolderSimpleIcon className="size-4 text-muted-foreground" />
            <p className="mt-1.5 truncate text-[12px]">{f}</p>
            <p className="font-mono text-[10px] text-muted-foreground">{[4, 2, 1][i]} files</p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-[6px] border border-dashed border-border px-3 py-2.5 text-[12px] text-muted-foreground">
        <PlusIcon className="size-3.5" /> Drop 40 files · duplicates skipped by content
      </div>
    </Card>
  );
}

function ScheduleMock() {
  return (
    <Card className="p-1.5">
      {[
        ['Every Monday 08:00', 'Obligations register', 'Project Cedar'],
        ['When documents arrive', 'Key terms review', 'Project Aster'],
        ['1st of the month', 'Renewals in the next 90 days', 'Portfolio'],
      ].map(([w, n, m]) => (
        <div key={n} className="flex items-center gap-3 border-b border-border px-2 py-2.5 last:border-0">
          <ClockIcon className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate">{n}</p>
            <p className="text-[11px] text-muted-foreground">
              {w} · {m}
            </p>
          </div>
          <span className="flex items-center gap-1 text-[11px] text-verified">
            <Diamond className="size-[5px]" /> On
          </span>
        </div>
      ))}
    </Card>
  );
}

export function Mock({ name }: { name: MockName }) {
  switch (name) {
    case 'composer':
      return <ComposerMock />;
    case 'answer':
      return <AnswerMock />;
    case 'question':
      return <QuestionMock />;
    case 'sandbox':
      return <SandboxMock />;
    case 'vault':
      return <VaultMock />;
    case 'versions':
      return <VersionsMock />;
    case 'review':
      return <ReviewMock />;
    case 'cell':
      return <CellMock />;
    case 'workflowList':
      return <WorkflowListMock />;
    case 'playbook':
      return <PlaybookMock />;
    case 'diligence':
      return <DiligenceMock />;
    case 'redline':
      return <RedlineMock />;
    case 'draft':
      return <DraftMock />;
    case 'oversight':
      return <OversightMock />;
    case 'audit':
      return <AuditMock />;
    case 'roles':
      return <RolesMock />;
    case 'matter':
      return <MatterMock />;
    case 'schedule':
      return <ScheduleMock />;
  }
}

const NAV_ITEMS = [
  [NotePencilIcon, 'New chat'],
  [MagnifyingGlassIcon, 'Search'],
  [ClockIcon, 'Chats'],
  [SquaresFourIcon, 'Workflows'],
  [BooksIcon, 'Library'],
  [GearSixIcon, 'Settings'],
] as const;

const THREADS = {
  Today: ['Uncapped liability across Aster', 'Notice period in the Cedar Row lease', 'Draft NDA for Quillon'],
  'This week': ['Change of control sweep', 'Chronology for the Harbor dispute', 'Renewals in Q1'],
  Earlier: ['Lattice DPA subprocessors', 'Meridian exclusivity term'],
} as const;

/** The whole app, framed: the platform hero. */
export function AppWindow({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('rounded-[14px] bg-white/10 p-2 backdrop-blur-sm md:p-2.5', className)}>
      <div className="flex h-[440px] overflow-hidden rounded-[10px] bg-background text-[12px] text-foreground md:h-[560px]">
        <div className="hidden w-[176px] shrink-0 flex-col border-r border-border bg-sidebar p-2.5 md:flex">
          <div className="flex items-center justify-between px-1 pb-3">
            <span className="flex items-center gap-1.5 text-[15px]">
              <BrandGlyph className="size-4" />
              <Wordmark className="text-[15px]" />
            </span>
          </div>
          {NAV_ITEMS.map(([Icon, label], i) => (
            <div
              key={label}
              className={cn('flex items-center gap-2 rounded-[6px] px-2 py-1.5', i === 0 && 'mb-1 border border-border bg-card', i === 2 && 'bg-sidebar-accent')}
            >
              <Icon className="size-3.5 text-muted-foreground" />
              {label}
            </div>
          ))}
          <p className="mt-4 flex items-center gap-1 px-2 text-[10.5px] text-muted-foreground">
            Matters <CaretDownIcon className="size-2.5" />
          </p>
          {['Project Aster', 'Cedar Row lease', 'Harbor dispute', 'Quillon NDA'].map((m) => (
            <div key={m} className="flex items-center gap-2 px-2 py-1.5">
              <FolderSimpleIcon className="size-3.5 text-muted-foreground" />
              <span className="truncate">{m}</span>
            </div>
          ))}
        </div>
        <div className="hidden w-[200px] shrink-0 flex-col border-r border-border p-2.5 lg:flex">
          <p className="px-1 pb-2 font-medium">Chats</p>
          {Object.entries(THREADS).map(([group, items]) => (
            <div key={group} className="mb-3">
              <p className="px-1 pb-1 text-[10.5px] text-muted-foreground">{group}</p>
              {items.map((t) => (
                <p key={t} className="truncate border-b border-border px-1 py-2">
                  {t}
                </p>
              ))}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center bg-pane p-6">
          <p className="display-xs text-center text-[26px]! text-foreground/80">What can Lumen do for you?</p>
          <div className="mt-5 w-full max-w-[440px] rounded-[10px] border border-border bg-card p-3 shadow-md">
            <p className="text-muted-foreground">Ask about a matter, a clause or a party…</p>
            <div className="mt-6 flex items-center gap-2 text-muted-foreground">
              <PlusIcon className="size-3.5" />
              <PaperclipIcon className="size-3.5" />
              <SlidersHorizontalIcon className="size-3.5" />
              <span className="flex-1" />
              <MicrophoneIcon className="size-3.5" />
              <span className="grid size-6 place-items-center rounded-[5px] bg-navy text-white dark:bg-[#F5F3EF] dark:text-navy">
                <ArrowUpIcon className="size-3" weight="bold" />
              </span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {['Review a contract', 'Diligence', 'Draft', 'Chronology'].map((c) => (
              <span key={c} className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px]">
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
