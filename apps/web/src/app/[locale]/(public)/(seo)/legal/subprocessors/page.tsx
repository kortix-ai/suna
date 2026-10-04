import type { Metadata } from 'next';

import Link from '@/components/site-link';
import { PageHero } from '@/features/marketing/component/page-hero';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * The authoritative subprocessor list that the Data Processing Addendum
 * (section 7.2, Annex III) points to. English only, like the other legal
 * texts. A new entry needs 30 days' notice to customers before it processes
 * customer personal data (DPA section 7.3): update LAST_UPDATED and email the
 * change to subscribers first.
 */
const LAST_UPDATED = 'September 29, 2026';

export const metadata: Metadata = {
  title: 'Subprocessors',
  description: 'The third parties that process customer personal data for Kortix.',
  alternates: { canonical: '/legal/subprocessors' },
};

type Row = { name: string; purpose: string; location: string };

const CORE: Row[] = [
  {
    name: 'Amazon Web Services, Inc.',
    purpose: 'Hosting of the API and gateway, storage, secrets, transactional email (SES)',
    location: 'United Kingdom',
  },
  {
    name: 'Supabase, Inc.',
    purpose: 'Database and authentication',
    location: 'United Kingdom',
  },
  {
    name: 'Cloudflare, Inc.',
    purpose: 'DNS, content delivery, web application firewall',
    location: 'Global edge network',
  },
  {
    name: 'Vercel Inc.',
    purpose: 'Website and web app hosting, web analytics',
    location: 'Global edge network; functions in United Kingdom',
  },
  {
    name: 'Scaleway SAS',
    purpose: 'Servers and storage for agent sandboxes',
    location: 'France, Netherlands, Poland',
  },
  {
    name: 'PlanetScale, Inc.',
    purpose: 'Sandbox control-plane database',
    location: 'Germany',
  },
  {
    name: 'Daytona Platforms, Inc.',
    purpose: 'Secondary agent sandbox provider',
    location: 'United States',
  },
  {
    name: 'OpenRouter, Inc.',
    purpose: 'Routing of requests to Kortix-managed AI models',
    location: 'United States',
  },
  {
    name: 'CoreWeave, Inc.; Fireworks AI, Inc.; Decart',
    purpose: 'Inference for Kortix-managed AI models, reached through OpenRouter',
    location: 'United States',
  },
  {
    name: 'GitHub, Inc.',
    purpose: 'Hosting of Kortix-managed project repositories',
    location: 'United States',
  },
  {
    name: 'Resend, Inc.; Mailtrap (Railsware)',
    purpose: 'Transactional email delivery (fallback providers)',
    location: 'United States',
  },
  {
    name: 'Better Stack, Inc.',
    purpose: 'Application logs and error reporting',
    location: 'European Union',
  },
  {
    name: 'Langfuse GmbH',
    purpose: 'AI request metadata (model, tokens, latency); no prompts or outputs',
    location: 'European Union',
  },
  {
    name: 'PostHog, Inc.',
    purpose: 'Product analytics',
    location: 'European Union',
  },
  {
    name: 'Tavily; Serper; Firecrawl',
    purpose: 'Web search and page retrieval when an agent uses these tools',
    location: 'United States',
  },
  {
    name: 'Stripe, Inc.',
    purpose: 'Payment processing and billing',
    location: 'United States, European Union',
  },
];

const OPTIONAL: Row[] = [
  {
    name: 'Composio',
    purpose: 'Managed connectors to third-party apps, when you connect one',
    location: 'United States',
  },
  {
    name: 'Slack Technologies, LLC',
    purpose: 'Slack channel, when you connect a workspace',
    location: 'United States',
  },
  {
    name: 'Microsoft Corporation',
    purpose: 'Microsoft Teams channel, when you connect a tenant',
    location: 'United States',
  },
  {
    name: 'AgentMail',
    purpose: 'Agent email inboxes, when you enable them',
    location: 'United States',
  },
];

const PROSE = 'text-muted-foreground text-base leading-7 text-pretty';
const LINK =
  'text-foreground decoration-foreground/25 hover:decoration-foreground/60 underline underline-offset-4 transition-colors';

function RowsTable({ rows }: { rows: Row[] }) {
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
        {rows.map((row) => (
          <TableRow key={row.name}>
            <TableCell className="text-foreground align-top font-medium whitespace-normal">
              {row.name}
            </TableCell>
            <TableCell className="text-muted-foreground align-top whitespace-normal">
              {row.purpose}
            </TableCell>
            <TableCell className="text-muted-foreground align-top whitespace-normal">
              {row.location}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function SubprocessorsPage() {
  return (
    <main className="bg-background min-h-screen">
      <PageHero size="band" title="Subprocessors" sub={`Last updated ${LAST_UPDATED}`} />
      <div className="mx-auto max-w-4xl px-6 pt-12 pb-24">
        <div className="space-y-4">
          <p className={PROSE}>
            Kortix AI Corp engages the third parties below to process customer personal data when we
            provide the managed cloud Services. Each is bound by written data protection terms no
            less protective than our Data Processing Addendum. We host the Services mainly in the
            United Kingdom and the European Union.
          </p>
          <p className={PROSE}>
            We give at least 30 days&apos; notice before a new subprocessor processes customer
            personal data. To receive these notices, email{' '}
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
          <RowsTable rows={CORE} />
        </div>

        <h2 className="text-foreground mt-12 text-lg font-medium tracking-tight">
          Used only when you enable a feature
        </h2>
        <div className="mt-4">
          <RowsTable rows={OPTIONAL} />
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
