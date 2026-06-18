import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import Link from 'next/link';
import type { ReactNode } from 'react';

type WhyRow = {
  title: string;
  cta: { label: string; href: string };
  body: ReactNode;
};

const ROWS: WhyRow[] = [
  {
    title: 'When you want to stay in control',
    cta: { label: 'See how it works', href: '#how-it-works' },
    body: (
      <>
        <p>
          With most tools, you change a setting and just have to trust it stuck. Kortix keeps a
          clear record of every change your team makes — who changed what, and when.
        </p>
        <p>
          <strong>If something goes wrong, you can undo it in seconds</strong> and get back to a
          version you know was working. No guessing, no support ticket.
        </p>
      </>
    ),
  },
  {
    title: 'When you care about security',
    cta: { label: 'Explore security', href: '#security' },
    body: (
      <>
        <p>
          Every AI agent you run gets its own walled-off space and only the access it genuinely
          needs — nothing more. So one agent can never reach into something it shouldn&apos;t.
        </p>
        <p>
          And instead of scattered passwords and keys across a dozen services,{' '}
          <strong>there&apos;s one key you manage</strong>. Less to track, far less to leak.
        </p>
      </>
    ),
  },
  {
    title: "When you'd rather own your setup",
    cta: { label: 'Read about hosting', href: '/enterprise' },
    body: (
      <>
        <p>
          Kortix is open source, so you&apos;re never locked in. Run it in our cloud, in your own,
          or entirely on your own servers — whatever your business needs.
        </p>
        <p>
          Your data stays where you want it, and <strong>the platform is yours to keep</strong>, on
          your terms.
        </p>
      </>
    ),
  },
  {
    title: 'When you want it to just work',
    cta: { label: 'Get started', href: '/auth' },
    body: (
      <>
        <p>
          You shouldn&apos;t need a team of engineers to get going. Kortix is built so the people
          who use it day to day can set things up, adjust them, and trust the result.
        </p>
        <p>
          Powerful enough for your developers, <strong>simple enough for everyone else</strong>.
        </p>
      </>
    ),
  },
];

function RowCta({ label, href }: { label: string; href: string }) {
  return (
    <Link
      href={href}
      className="group text-kortix-base hit-area-6 flex w-fit items-center gap-1 text-xs tracking-widest uppercase"
    >
      {label}
      <span className="inline-block text-sm opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        &nbsp;↗
      </span>
    </Link>
  );
}

export function WhyKortix() {
  return (
    <section className="bg-foreground text-background relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 z-10 mask-y-from-10% opacity-35"
        aria-hidden
      >
        <KortixLetterField seed={3382} className="invert" />
      </div>

      <div className="px-6 py-16 sm:py-24 lg:px-0">
        <div className="z-20 mx-auto max-w-6xl">
          <div className="mx-auto mb-16 max-w-2xl space-y-3 text-center">
            <h2 className="text-background text-3xl font-medium tracking-tight sm:text-4xl">
              Why Kortix?
            </h2>
            <p className="text-background/70 text-base leading-relaxed text-balance">
              Every AI platform sounds the same on paper. Here&apos;s what actually changes once
              you&apos;re running on Kortix.
            </p>
          </div>

          <div className="mx-auto w-full max-w-4xl">
            {ROWS.map((row) => (
              <div
                key={row.title}
                className="border-background/20 grid gap-5 border-b px-0 py-11 max-md:grid-cols-1 md:grid-cols-[1fr_1.05fr] md:gap-x-16 md:gap-y-10 md:px-2 md:py-14"
              >
                <div>
                  <h3 className="mb-3.5 text-xl leading-tight font-semibold tracking-tight md:mb-5">
                    {row.title}
                  </h3>
                  <RowCta label={row.cta.label} href={row.cta.href} />
                </div>
                <div className="text-background/70 [&_strong]:text-background space-y-3.5 text-lg leading-relaxed [&_p+p]:mt-3.5 [&_strong]:font-medium">
                  {row.body}
                </div>
              </div>
            ))}
          </div>

          <div className="mx-auto mt-28 flex w-full flex-col items-center justify-center space-y-0 text-center">
            <h1 className="text-background text-xl font-semibold text-balance">
              Get going fast. Grow without worry.
            </h1>

            <h1 className="text-background text-xl font-semibold text-balance">
              Kortix isn't just simple to start — it's built to grow with you.
            </h1>
          </div>
        </div>
      </div>
    </section>
  );
}

export default WhyKortix;
