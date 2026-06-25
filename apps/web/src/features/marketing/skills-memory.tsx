'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Brain, Check, FileText, GraduationCap } from 'lucide-react';
import type { ReactNode } from 'react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

function ChatSnippet({ ask, reply }: { ask: ReactNode; reply: ReactNode }) {
  return (
    <div className="border-border bg-background space-y-3 rounded-xl border p-4">
      <div className="flex items-start gap-2.5">
        <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold">
          M
        </span>
        <p className="text-foreground min-w-0 text-sm leading-relaxed">
          <span className="text-muted-foreground font-medium">@Kortix</span> {ask}
        </p>
      </div>
      <div className="flex items-start gap-2.5">
        <span className="bg-foreground flex size-6 shrink-0 items-center justify-center rounded-md">
          <KortixLogo size={12} className="text-background" />
        </span>
        <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-sm leading-relaxed">
          <Check className="text-kortix-green size-3.5 shrink-0" />
          {reply}
        </p>
      </div>
    </div>
  );
}

function FileChip({ path }: { path: string }) {
  return (
    <span className="border-border bg-background text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs">
      <FileText className="size-3 shrink-0" />
      {path}
    </span>
  );
}

function LearnCard({
  icon: Icon,
  eyebrow,
  title,
  body,
  snippets,
  files,
  className,
}: {
  icon: typeof Brain;
  eyebrow: string;
  title: string;
  body: string;
  snippets: { ask: ReactNode; reply: ReactNode }[];
  files: string[];
  className?: string;
}) {
  return (
    <div
      className={cn('border-border bg-card flex flex-col rounded-2xl border p-6 md:p-7', className)}
    >
      <span className="border-border bg-background text-foreground flex size-11 items-center justify-center rounded-xl border">
        <Icon className="size-5" />
      </span>
      <p className="text-muted-foreground mt-5 font-mono text-xs tracking-wide uppercase">
        {eyebrow}
      </p>
      <h3 className="text-foreground mt-1.5 text-xl font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{body}</p>

      <div className="mt-5 space-y-3">
        {snippets.map((s, i) => (
          <ChatSnippet key={i} ask={s.ask} reply={s.reply} />
        ))}
      </div>

      <div className="mt-auto pt-5">
        <p className="text-muted-foreground/80 mb-2 text-xs">Saved as files in your repo</p>
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <FileChip key={f} path={f} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SkillsMemory() {
  return (
    <section id="skills-memory" className={sectionShell}>
      <Reveal>
        <div className="mb-10 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            It learns
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            You don&apos;t just use Kortix. You teach it.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            Give it a skill once and the whole workforce can run it. Tell it to remember anything
            and it sticks — like onboarding a hire who gets better over time.
          </p>
        </div>
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-2">
        <Reveal>
          <LearnCard
            className="h-full"
            icon={GraduationCap}
            eyebrow="Skills"
            title="Teach it once, it reuses it forever."
            body="Hand the agent a reusable capability — how you close the month, your deploy checklist — and it's saved as a skill any agent can run, anytime."
            snippets={[
              {
                ask: 'here’s how we close the month — save it as a skill',
                reply: (
                  <>
                    Saved <span className="text-foreground font-medium">close-month</span>. Any
                    agent can run it now.
                  </>
                ),
              },
            ]}
            files={['skills/close-month/SKILL.md', 'skills/deploy-checklist/SKILL.md']}
          />
        </Reveal>

        <Reveal delay={0.06}>
          <LearnCard
            className="h-full"
            icon={Brain}
            eyebrow="Memory"
            title="Tell it to remember anything, and it sticks."
            body="Decisions, owners, preferences, context. Stored as versioned memory files in your repo — readable, editable, auditable, and shared across the org."
            snippets={[
              {
                ask: 'remember everything Marko ships this week and brief me Friday',
                reply: <>Got it — tracking it in memory.</>,
              },
              {
                ask: 'remember: Sarah owns billing',
                reply: <>Noted in memory.</>,
              },
              {
                ask: 'remember we never email on Fridays',
                reply: <>Saved. I won’t.</>,
              },
            ]}
            files={['memory/company.md', 'memory/decisions.md', 'memory/people.md']}
          />
        </Reveal>
      </div>

      <Reveal delay={0.1}>
        <p className="text-muted-foreground mt-8 text-center text-sm">
          Skills and memory are just files in your repo —{' '}
          <span className="text-foreground font-medium">versioned, shareable, yours.</span>
        </p>
      </Reveal>
    </section>
  );
}

export default SkillsMemory;
