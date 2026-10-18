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

export const metadata: Metadata = {
  title: 'Subprocessors',
  description: 'The third parties that process customer personal data for Kortix.',
  alternates: { canonical: '/legal/subprocessors' },
};

const PROSE = 'text-muted-foreground text-base leading-7 text-pretty';
const LINK =
  'text-foreground decoration-foreground/25 hover:decoration-foreground/60 underline underline-offset-4 transition-colors';

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

export default function SubprocessorsPage() {
  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-4xl px-6 pt-28 pb-24 sm:pt-36">
        <h1 className="text-3xl font-medium tracking-tight text-balance md:text-4xl">
          Subprocessors
        </h1>
        <p className="text-muted-foreground mt-2 text-sm tabular-nums">
          Last updated {formatSubprocessorDate(SUBPROCESSORS_UPDATED)}
        </p>

        <div className="mt-8 space-y-4">
          <p className={PROSE}>
            Kortix AI Corp engages the third parties below to process customer personal data when we
            provide the managed cloud Services. Each is bound by written data protection terms no
            less protective than our Data Processing Addendum. We host the Services mainly in the
            United Kingdom and the European Union; agent sandboxes also run in the United States.
          </p>
          <p className={PROSE}>
            We give at least 30 days&apos; notice before a new subprocessor processes customer
            personal data. We email the notice to the owners and admins of every paid account, and
            the new row shows the date it takes effect. To receive these notices on another address,
            email{' '}
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

        <h2 className="text-foreground mt-12 text-lg font-medium tracking-tight">
          Core infrastructure and services
        </h2>
        <div className="mt-4">
          <RowsTable rows={SUBPROCESSORS_CORE} />
        </div>

        <h2 className="text-foreground mt-12 text-lg font-medium tracking-tight">
          Used only when you enable a feature
        </h2>
        <div className="mt-4">
          <RowsTable rows={SUBPROCESSORS_OPTIONAL} />
        </div>

        <p className={`${PROSE} mt-12`}>
          Services you choose to connect, models you reach with your own API keys or your own
          account (for example OpenAI, Anthropic, or Google), and apps an agent acts on at your
          direction act on your behalf. They are not Kortix subprocessors; their own terms apply.
        </p>
      </div>
    </main>
  );
}
