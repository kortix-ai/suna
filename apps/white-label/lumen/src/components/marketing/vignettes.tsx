import { cn } from '@kortix/ui';

// Product vignettes for the marketing page: small, static renders of each
// module, drawn with the app's own tokens. Every value is the real answer on the
// synthetic demo dataset (demo-data/: Project Aster): page counts from
// manifest.json, clause numbers and quotes from demo-data/src. Change the
// dataset, change these.

function Frame({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-card shadow-lg', className)} aria-hidden>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="size-2 rounded-full bg-muted-foreground/25" />
        <span className="size-2 rounded-full bg-muted-foreground/25" />
        <span className="size-2 rounded-full bg-muted-foreground/25" />
        <span className="ml-2 truncate text-[11px] text-muted-foreground">{title}</span>
      </div>
      <div className="p-4 text-[13px] leading-relaxed">{children}</div>
    </div>
  );
}

const Chip = ({ n }: { n: number }) => (
  <span className="mx-0.5 inline-grid size-4 place-items-center rounded bg-brand/15 align-[1px] font-mono text-[10px] text-brand">{n}</span>
);

export function AssistantVignette() {
  return (
    <Frame title="Project Aster · Assistant">
      <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-muted px-3 py-2">Which agreements have uncapped liability?</div>
      <div className="mt-3 space-y-2">
        <p>
          One agreement leaves liability uncapped: the <b>Master Services Agreement</b> with Quillon Analytics. Clause 11.1 excludes
          any limit for either party
          <Chip n={1} />.
        </p>
        <p>
          The SaaS agreement caps liability at twelve months of fees
          <Chip n={2} />.
        </p>
      </div>
      <div className="mt-3 rounded-lg border border-border bg-background p-3">
        <p className="text-[11px] text-muted-foreground">
          <span className="font-mono text-brand">[1]</span> msa-brightwater-quillon.pdf · p. 2 · §11.1
        </p>
        <p className="mt-1 border-l-2 border-brand pl-2">
          Neither party&apos;s liability under or in connection with this Agreement … <mark className="bg-brand/15 text-foreground">shall be limited or capped in amount</mark>.
        </p>
      </div>
    </Frame>
  );
}

// The three real hits for "indemnif" in the demo matter's Vault (one page each).
const DOCS = [
  ['msa-brightwater-quillon.pdf', 'PDF', 2],
  ['supply-agreement-meridian.pdf', 'PDF', 1],
  ['saas-agreement-lattice.docx', 'DOCX', 1],
] as const;

export function VaultVignette() {
  return (
    <Frame title="Project Aster · Vault">
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-muted-foreground">
        <span className="text-foreground">indemnif</span>
        <span className="ml-auto text-[11px]">3 documents, 3 pages</span>
      </div>
      <ul className="divide-y divide-border">
        {DOCS.map(([name, type, page]) => (
          <li key={name} className="flex items-center gap-2 py-2">
            <span className="grid h-6 w-9 place-items-center rounded bg-muted font-mono text-[10px] text-muted-foreground">{type}</span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">p. {page}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

const GRID = [
  ['MSA · Quillon', 'Uncapped', 'New York', 'Consent'],
  ['SaaS · Lattice', '12 months’ fees', 'England and Wales', 'Consent'],
  ['Supply · Meridian', 'GBP 2,000,000 a year', 'England and Wales', 'Consent'],
] as const;

export function ReviewVignette() {
  return (
    <Frame title="Project Aster · Tabular review">
      <table className="w-full text-left text-[12px]">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1.5 font-normal">Document</th>
            <th className="py-1.5 font-normal">Liability cap</th>
            <th className="py-1.5 font-normal">Governing law</th>
            <th className="py-1.5 font-normal">Assignment</th>
          </tr>
        </thead>
        <tbody>
          {GRID.map((r) => (
            <tr key={r[0]} className="border-b border-border/60 last:border-0">
              <td className="py-2 pr-2 font-medium">{r[0]}</td>
              <td className="py-2 pr-2">
                {r[1]}
                <Chip n={1} />
              </td>
              <td className="py-2 pr-2">{r[2]}</td>
              <td className="py-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{r[3]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground">48 / 48 cells · every value cited</p>
    </Frame>
  );
}

export function WorkflowVignette() {
  return (
    <Frame title="Mutual NDA · Review against playbook">
      <div className="mb-3 flex gap-2 text-[11px]">
        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">1 High</span>
        <span className="rounded-full bg-muted px-2 py-0.5">2 Medium</span>
        <span className="rounded-full bg-muted px-2 py-0.5">1 Low</span>
      </div>
      <div className="rounded-lg border border-border p-3">
        <p className="font-medium">Confidentiality term exceeds playbook</p>
        <p className="mt-0.5 text-muted-foreground">7 years; your playbook allows at most 3.</p>
        <p className="mt-2 rounded bg-muted/60 px-2 py-1.5">
          …shall survive for a period of <del className="text-destructive/80">seven (7)</del>{' '}
          <ins className="bg-brand/15 text-foreground no-underline">three (3)</ins> years…
        </p>
      </div>
    </Frame>
  );
}
