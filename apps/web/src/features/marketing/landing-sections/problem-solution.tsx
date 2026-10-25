'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { XCircleIcon } from '@phosphor-icons/react/dist/ssr';


// Each "with" line is on /security, in How it works or in the docs.
const WITHOUT = [
  'Prompts and rules live in a vendor’s database',
  'Every chat starts from zero',
  'Each person wires up their own tools',
  'One model, one vendor',
];
const WITH = [
  'Agents, skills and rules are files in your repo',
  'Memory builds up as files your agents read',
  'Connectors set up once, scoped per agent',
  'Any model, with your key or ours',
];

/** One half of the card: title and label on one row, the four facts under it. */
function Panel({
  kind,
  title,
  label,
  items,
}: {
  kind: 'without' | 'with';
  title: string;
  label: string;
  items: string[];
}) {
  const after = kind === 'with';
  return (
    <div className="bg-background flex flex-col gap-8 rounded-md p-6 lg:p-8">
      <div className="flex items-baseline justify-between gap-4">
        <h3
          className={
            after
              ? 'text-foreground text-lg font-medium tracking-tight text-balance'
              : 'text-muted-foreground text-lg font-medium tracking-tight text-balance'
          }
        >
          {title}
        </h3>
        <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      </div>
      <ul className="flex flex-col gap-3.5">
        {items.map((item) => (
          <li
            key={item}
            className={
              after
                ? 'text-foreground flex items-start gap-3 text-sm'
                : 'text-muted-foreground flex items-start gap-3 text-sm'
            }
          >
            {after ? (
              <SolidCheckIcon className="text-ring mt-0.5" />
            ) : (
              <XCircleIcon aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0" />
            )}
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Problem → solution: the two-tone title and one line of description, as in
 * How it works, then one card on a plain band (after Polar's
 * product card): a header with the mark, and two panels, without Kortix and
 * with it, each holding its title, label and facts.
 */
export function ProblemSolution() {
  return (
    <section id="why-kortix" className="scroll-mt-16 py-24 lg:py-32">
      <div className="px-8 lg:px-28">
        <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
          Your know-how is everywhere.
          <span className="text-muted-foreground block">Kortix keeps it in one repo.</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl text-base text-pretty">
          Chats, docs and people&apos;s heads become files your agents work from.
        </p>
      </div>

      <div className="kx-rail-fade mt-12 border-y px-4 lg:px-17">
        <div className="bg-background relative flex items-center justify-center overflow-hidden px-4 py-12 lg:py-24">
          {/* The frame carries the grey; the panels sit on the page background.
              Panel radius = frame radius − the 8px inset. */}
          <div className="bg-card relative w-full max-w-240 rounded-lg border p-2">
            <div className="flex items-center justify-between px-4 pt-2 pb-3.5">
              <KortixLogo size={15} variant="logomark" />
              <span className="text-muted-foreground text-sm">Before and after</span>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <Panel kind="without" title="Agents that forget your company." label="Most agents today" items={WITHOUT} />
              <Panel kind="with" title="Agents that work from your company." label="With Kortix" items={WITH} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
