import type { Metadata } from 'next';

import Link from '@/components/site-link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatSubprocessorDate,
  subprocessorEffectiveDate,
  SUBPROCESSORS_CORE,
  SUBPROCESSORS_OPTIONAL,
  SUBPROCESSORS_UPDATED,
  type Subprocessor,
} from '@kortix/shared/subprocessors';

import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Subprocessors',
  description: 'The third parties that process customer personal data for Kortix.',
  alternates: { canonical: '/legal/subprocessors' },
};

const PROSE = 'text-muted-foreground text-base leading-7 text-pretty';
const LINK =
  'text-foreground decoration-border hover:decoration-foreground underline underline-offset-4 transition-colors';

function RowsTable({ rows }: { rows: readonly Subprocessor[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subprocessor</TableHead>
          <TableHead>Purpose</TableHead>
          <TableHead>Location</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const effective = subprocessorEffectiveDate(row);
          return (
            <TableRow key={row.name}>
              <TableCell className="text-foreground align-top font-medium whitespace-normal">
                {row.name}
              </TableCell>
              <TableCell className="text-muted-foreground align-top whitespace-normal">
                {row.purpose}
              </TableCell>
              <TableCell className="text-muted-foreground align-top whitespace-normal">
                {row.location}
                {effective && (
                  <span className="text-foreground block">
                    From {formatSubprocessorDate(effective)}
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Rail entries: the legal documents, then this page (Buio's legal nav). */
const LEGAL_PAGES = [
  { href: '/legal?tab=imprint', label: 'Imprint' },
  { href: '/legal?tab=terms', label: 'Terms of Service' },
  { href: '/legal?tab=privacy', label: 'Privacy Policy' },
] as const;

const RAIL_ITEM =
  'outline-ring flex min-h-11 shrink-0 items-center text-sm whitespace-nowrap focus-visible:outline-2 lg:min-h-9';

/**
 * Buio's legal layout: a two-tone header, then the shared 4-column grid with
 * the legal rail in column 1 and the text in columns 2–4 (the tables need the
 * width; the paragraphs keep a 2xl measure). The hero's measure.
 */
export default function SubprocessorsPage() {
  return (
    <main className="bg-background min-h-screen pt-16">
      <div className={cn(MARKETING_CONTAINER, 'pb-24 md:pb-30')}>
        <SectionHeading
          as="h1"
          className="pt-24 md:pt-30"
          title="Subprocessors."
          titleMuted="Who processes customer data for us."
          description={
            <span className="tabular-nums">
              Last updated {formatSubprocessorDate(SUBPROCESSORS_UPDATED)}
            </span>
          }
        />

        <div className="border-border mt-16 grid grid-cols-1 gap-y-12 border-t pt-8 lg:grid-cols-4">
          <nav
            aria-label="Legal documents"
            className="scrollbar-hide -mx-4 flex gap-x-6 overflow-x-auto px-4 lg:sticky lg:top-24 lg:mx-0 lg:flex-col lg:self-start lg:overflow-visible lg:px-0 lg:pr-8"
          >
            {LEGAL_PAGES.map((page) => (
              <Link
                key={page.href}
                href={page.href}
                className={cn(
                  RAIL_ITEM,
                  'text-muted-foreground hover:text-foreground duration-moderate transition-colors',
                )}
              >
                {page.label}
              </Link>
            ))}
            <span aria-current="page" className={cn(RAIL_ITEM, 'text-foreground')}>
              Subprocessors
            </span>
          </nav>

          <div className="min-w-0 lg:col-span-3">
            <div className="max-w-2xl space-y-4">
              <p className={PROSE}>
                Kortix AI Corp engages the third parties below to process customer personal data
                when we provide the managed cloud Services. Each is bound by written data protection
                terms no less protective than our Data Processing Addendum. We host the Services
                mainly in the United Kingdom and the European Union; agent sandboxes also run in the
                United States.
              </p>
              <p className={PROSE}>
                We give at least 30 days&apos; notice before a new subprocessor processes customer
                personal data. We email the notice to the owners and admins of every paid account,
                and the new row shows the date it takes effect. To receive these notices on another
                address, email{' '}
                <a href="mailto:privacy@kortix.com" className={LINK}>
                  privacy@kortix.com
                </a>
                . Our{' '}
                <Link href="/legal?tab=privacy" className={LINK}>
                  privacy policy
                </Link>{' '}
                describes how we handle personal information.
              </p>
            </div>

            <h2 className="text-foreground mt-16 text-xl font-medium tracking-tight text-balance md:text-2xl">
              Core infrastructure and services
            </h2>
            <div className="mt-6">
              <RowsTable rows={SUBPROCESSORS_CORE} />
            </div>

            <h2 className="text-foreground mt-16 text-xl font-medium tracking-tight text-balance md:text-2xl">
              Used only when you enable a feature
            </h2>
            <div className="mt-6">
              <RowsTable rows={SUBPROCESSORS_OPTIONAL} />
            </div>

            <p className={cn(PROSE, 'mt-16 max-w-2xl')}>
              Services you choose to connect, models you reach with your own API keys or your own
              account (for example OpenAI, Anthropic, or Google), and apps an agent acts on at your
              direction act on your behalf. They are not Kortix subprocessors; their own terms
              apply.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
