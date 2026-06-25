'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Check, Minus } from 'lucide-react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

// Structural axes where Kortix wins by nature of being open + repo-native.
// Competitor cells are kept high-level (— = not applicable / closed by design),
// never specific invented feature claims.
const ROWS: { label: string; sub?: string; kortix: true; others: false }[] = [
  { label: 'Open source', sub: 'Read it, fork it, audit it', kortix: true, others: false },
  {
    label: 'You own your data, agents & code',
    sub: 'Self-hostable on your own infra',
    kortix: true,
    others: false,
  },
  {
    label: 'Any model — bring your own key',
    sub: 'Not locked to one provider',
    kortix: true,
    others: false,
  },
  {
    label: 'Your company as a Git repo',
    sub: 'Agents, skills, context & memory versioned as files',
    kortix: true,
    others: false,
  },
  {
    label: 'Runs your whole company',
    sub: '3,000+ tools via one connector layer — every department',
    kortix: true,
    others: false,
  },
  {
    label: 'Everywhere you work',
    sub: 'Web/Desktop · Slack · Teams · Mobile',
    kortix: true,
    others: false,
  },
  {
    label: 'Multiplayer — shared across your org',
    sub: 'One team workforce, not a single-user assistant',
    kortix: true,
    others: false,
  },
];

const COMPETITORS = ['Claude Cowork', 'ChatGPT', 'Perplexity', 'Closed assistants'] as const;

function YesCell() {
  return (
    <span className="bg-kortix-green/15 text-kortix-green inline-flex size-6 items-center justify-center rounded-full">
      <Check className="size-3.5" strokeWidth={3} />
    </span>
  );
}

function NoCell() {
  return (
    <span className="text-muted-foreground/50 inline-flex size-6 items-center justify-center">
      <Minus className="size-4" />
    </span>
  );
}

export function Compare() {
  return (
    <section id="compare" className={sectionShell}>
      <Reveal>
        <div className="mb-10 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            Compare
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            Others give you an assistant. Kortix gives you a workforce you own.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            Closed assistants live inside someone else&apos;s product. Kortix is open, runs on your
            infrastructure, and works as your whole team&apos;s AI workforce.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="border-border bg-card overflow-hidden rounded-2xl border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] border-collapse text-left">
              <thead>
                <tr className="border-border border-b">
                  <th className="w-[34%] p-4 align-bottom sm:p-5" />
                  <th className="bg-primary/[0.04] border-border w-[16%] border-x p-4 text-center align-bottom sm:p-5">
                    <div className="flex flex-col items-center gap-2">
                      <span className="bg-foreground flex size-8 items-center justify-center rounded-lg">
                        <KortixLogo size={16} className="text-background" />
                      </span>
                      <span className="text-foreground text-sm font-semibold">Kortix</span>
                    </div>
                  </th>
                  {COMPETITORS.map((name) => (
                    <th
                      key={name}
                      className="text-muted-foreground p-4 text-center align-bottom text-sm font-medium sm:p-5"
                    >
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, i) => (
                  <tr
                    key={row.label}
                    className={cn(
                      'align-middle',
                      i !== ROWS.length - 1 && 'border-border border-b',
                    )}
                  >
                    <td className="p-4 sm:p-5">
                      <p className="text-foreground text-sm font-medium">{row.label}</p>
                      {row.sub ? (
                        <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                          {row.sub}
                        </p>
                      ) : null}
                    </td>
                    <td className="bg-primary/[0.04] border-border border-x p-4 text-center sm:p-5">
                      <div className="flex justify-center">
                        <YesCell />
                      </div>
                    </td>
                    {COMPETITORS.map((name) => (
                      <td key={name} className="p-4 text-center sm:p-5">
                        <div className="flex justify-center">
                          <NoCell />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-border bg-primary/[0.03] flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t px-5 py-4 text-center">
            <span className="text-foreground text-sm font-medium">
              Open, yours, runs everything.
            </span>
            <span className="text-muted-foreground text-sm">
              The same workforce — without the lock-in.
            </span>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export default Compare;
