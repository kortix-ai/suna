import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/ssr';

// The 24/7 loop (kortix-brand D18): what Kortix does for a company, beside
// what it is (D16's pillars). Every step is a claims.md row: Triggers (cron
// and webhook), One sandbox per session, Path to `main`, Approval gates,
// Agents edit themselves, Parallel work. Say "agents", never "AI workers",
// "self-driving" or "autonomous company" (positioning.md, retired lines).
const STEPS = [
  { id: 'trigger', n: '01', k: 'Trigger', v: 'A schedule or a webhook starts the work, at any hour.' },
  { id: 'work', n: '02', k: 'Work', v: 'An agent picks it up on its own cloud computer, with your skills, memory and tools.' },
  { id: 'review', n: '03', k: 'Review', v: 'The result lands as a change request. Approval rules you set decide what waits for a person.' },
  { id: 'learn', n: '04', k: 'Learn', v: 'What the agent learned goes back into your company memory and its skills.' },
  { id: 'repeat', n: '05', k: 'Repeat', v: 'The next run starts from there. Thousands of agents can run in parallel.' },
] as const;

/** Your company in loops: five steps that run around the clock. */
export function RunLoop() {
  return (
    <section id="run-24-7" className="scroll-mt-16 py-20 lg:py-28">
      <Heading
        title="Run your company 24/7."
        titleMuted="Agents work in loops. Your team sets the rules."
        sub="Kortix is the AI-native operating system for your company: agents pick up the work, do it, get it reviewed and learn from it, around the clock."
      />
      <Band className="mt-12">
        <ol className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step) => (
            <li key={step.id} className="bg-background flex flex-col gap-3 p-6 lg:p-8">
              <span className="text-muted-foreground font-mono text-xs tabular-nums">{step.n}</span>
              <h3 className="text-foreground text-lg font-medium tracking-tight">{step.k}</h3>
              <p className="text-muted-foreground text-sm text-pretty">{step.v}</p>
            </li>
          ))}
        </ol>
        <p className="bg-background text-foreground flex items-center gap-2 border-t px-6 py-4 text-sm lg:px-8">
          <ArrowsClockwiseIcon className="size-4 shrink-0" aria-hidden />
          Then it runs again, while your team sleeps.
        </p>
      </Band>
    </section>
  );
}
