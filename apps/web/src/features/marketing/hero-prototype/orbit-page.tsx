'use client';

import { Button } from '@/components/ui/button';
import { ArrowRightIcon, CheckCircleIcon, CircleIcon, CommandIcon } from '@phosphor-icons/react';
import { useId } from 'react';

/** Fictional, local artifact. No form, account creation, or network activity. */
export function OrbitPage({ signedUp, onSignup }: { signedUp: boolean; onSignup: () => void }) {
  const sectionId = useId();
  return (
    <article aria-label="Orbit launch page" className="bg-background text-foreground @container">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4 @lg:px-8">
        <span className="flex items-center gap-2 text-lg font-semibold">
          <CommandIcon className="size-5" />
          orbit
        </span>
        <nav aria-label="Orbit example navigation" className="flex items-center gap-4 text-xs">
          <a
            href={`#${sectionId}-product`}
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex h-12 items-center focus-visible:outline-2"
          >
            Product
          </a>
          <a
            href={`#${sectionId}-benefits`}
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex h-12 items-center focus-visible:outline-2"
          >
            Benefits
          </a>
        </nav>
      </header>
      <div className="px-6 pt-10 pb-8 @lg:px-10 @lg:pt-12">
        <p className="text-muted-foreground mb-4 text-xs">A calmer place to work together</p>
        <h3 className="max-w-sm text-3xl font-medium tracking-tight text-balance @lg:text-4xl">
          Keep your team
          <br />
          in sync.
        </h3>
        <p className="text-muted-foreground mt-4 max-w-sm text-sm leading-relaxed">
          Bring your projects, priorities, and people together. Make room for the work that matters.
        </p>
        <Button
          onClick={onSignup}
          className="mt-6 h-12 px-5 active:scale-[0.96] motion-reduce:transform-none"
        >
          {signedUp ? 'You’re exploring a demo' : 'Get started'}
          <ArrowRightIcon className="size-4" />
        </Button>
        {signedUp && (
          <p role="status" className="text-muted-foreground mt-3 text-xs">
            Orbit is an example page. No account was created.
          </p>
        )}
      </div>
      <div id={`${sectionId}-product`} className="mx-6 scroll-mt-24 border @lg:mx-10">
        <div className="bg-card flex items-center justify-between gap-3 border-b px-4 py-3">
          <span className="text-sm font-medium">This week, together</span>
          <span className="text-muted-foreground text-xs">3 priorities</span>
        </div>
        {[
          ['Launch the new website', 'Design', true],
          ['Share the product update', 'Product', true],
          ['Plan what comes next', 'Team', false],
        ].map(([title, team, done]) => (
          <div
            key={String(title)}
            className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
          >
            {done ? (
              <CheckCircleIcon className="text-muted-foreground size-4 shrink-0" />
            ) : (
              <CircleIcon className="text-muted-foreground size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 text-xs">{title}</span>
            <span className="text-muted-foreground hidden text-xs @sm:block">{team}</span>
          </div>
        ))}
      </div>
      <div
        id={`${sectionId}-benefits`}
        className="grid scroll-mt-24 gap-5 px-6 py-8 @lg:grid-cols-3 @lg:px-10"
      >
        {[
          ['01', 'Shared priorities', 'Everyone sees what matters.'],
          ['02', 'Clear ownership', 'Every next step has a name.'],
          ['03', 'Fewer status meetings', 'Progress speaks for itself.'],
        ].map(([number, title, detail]) => (
          <div key={number} className="border-t pt-4">
            <p className="text-muted-foreground mb-2 text-xs">{number}</p>
            <h4 className="text-xs font-medium">{title}</h4>
            <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">{detail}</p>
          </div>
        ))}
      </div>
    </article>
  );
}
