'use client';

import Link from 'next/link';
import { Reveal } from '@/components/home/reveal';

/* ─── Small horizontal rule divider ─── */
function Divider() {
  return <div className="w-8 h-px bg-foreground/10 my-12" />;
}

/* ─── Numbered doctrine item ─── */
function DoctrineItem({
  number,
  title,
  body,
}: {
  number: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <Reveal>
      <div className="flex gap-5">
        <span className="text-[11px] font-mono text-muted-foreground pt-0.5 shrink-0 w-6 text-right">
          {number}
        </span>
        <div>
          <p className="text-sm font-medium text-foreground mb-1">{title}</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
        </div>
      </div>
    </Reveal>
  );
}

/* ─── Inline stat chip ─── */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground">
        {value}
      </span>
      <span className="text-xs text-muted-foreground leading-snug">{label}</span>
    </div>
  );
}

export default function FactoryPageClient() {
  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-3xl mx-auto px-6 pt-28 sm:pt-36 pb-28 sm:pb-36">

        {/* ── Opening thesis ── */}
        <Reveal>
          <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-6">
            The Autonomy Factory
          </p>
        </Reveal>

        <Reveal delay={0.05}>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground leading-[1.1] mb-8">
            We build<br />
            self-driving companies.
          </h1>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl">
            Not tools. Not agents. Not workflows. Companies — with engineering departments, 
            operations teams, finance functions, customer support, growth engines — that run 
            themselves. Agents doing the actual work, 24/7, without a human touching every task.
          </p>
        </Reveal>

        <Divider />

        {/* ── The ratio ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-8">
            The ratio
          </h2>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="flex gap-10 sm:gap-16 mb-6">
            <Stat value="76%" label="Agents doing the work" />
            <Stat value="24%" label="Humans verifying, steering, governing" />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            This is not a forecast. It is our operating target — the ratio we run ourselves at today, 
            and the ratio we build toward with every company we work with. Humans are not removed. 
            They are elevated. They set direction, review outputs, make final calls on things that 
            matter. Agents handle the rest.
          </p>
        </Reveal>

        <Divider />

        {/* ── The factory ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-6">
            What we mean by factory
          </h2>
        </Reveal>

        <Reveal delay={0.05}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mb-5">
            A factory is a system for turning inputs into outputs at scale, reliably, repeatedly, 
            without depending on any individual person being present. That is what we build for companies.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            You feed the factory your goals, your tools, your context, your standards. 
            The factory produces: shipped code, closed tickets, drafted contracts, reconciled books, 
            outbound campaigns, synthesized research, recruited candidates. Every day. Whether you 
            are in the office or asleep.
          </p>
        </Reveal>

        <Divider />

        {/* ── The playbook ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-8">
            The playbook
          </h2>
        </Reveal>

        <div className="flex flex-col gap-7">
          <DoctrineItem
            number="01"
            title="Map the work"
            body="Every company has processes that run on human attention. We find them — support queues, reporting cycles, outbound sequences, QA checks, code review, invoice processing — and make them legible. You cannot automate what you have not named."
          />
          <DoctrineItem
            number="02"
            title="Build the agents"
            body="Each process becomes an agent. Not a chatbot. Not a prompt wrapper. A specialist — with its own identity, permissions, tools, memory, and trigger rules. An engineering agent that ships PRs. A finance agent that closes the books. A support agent that resolves tickets before a human sees them."
          />
          <DoctrineItem
            number="03"
            title="Connect everything"
            body="Agents are only as powerful as the tools they can reach. We wire the entire company stack — codebases, CRMs, databases, communication platforms, file systems, external APIs. An agent that cannot act is just a language model. An agent that can reach everything is an employee."
          />
          <DoctrineItem
            number="04"
            title="Run the loop"
            body={<>Autowork: the autonomous execution loop. An agent takes a task, works it through to completion, self-verifies the result, and only stops when it can prove the output is correct. No hand-holding. No approval at every step. The job either gets done or the agent escalates with a clear explanation of why.</>}
          />
          <DoctrineItem
            number="05"
            title="Let memory compound"
            body="Every session, every decision, every correction is retained. Agents remember what worked. They remember your preferences, your standards, your edge cases. The longer the factory runs, the smarter it gets. This is the compounding advantage humans cannot replicate at scale."
          />
          <DoctrineItem
            number="06"
            title="Humans govern, not operate"
            body="The final layer is human governance: reviewing what matters, correcting course, setting new objectives. Not touching every task. Not approving every output. Governing the system. This is the 24% — and it is the most leveraged 24% these people will ever spend."
          />
        </div>

        <Divider />

        {/* ── Why we prove it on ourselves ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-6">
            Highest conviction from highest exposure
          </h2>
        </Reveal>

        <Reveal delay={0.05}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl mb-4">
            We run our own company on Kortix. Every day. Our engineering, our operations, our 
            growth — agents doing the work, humans governing the system. We eat our own output 
            before we ship it to anyone else.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            This is not a product demo. It is how we operate. The credibility of the playbook 
            comes from the fact that we are living inside it. Every failure we encounter, we fix. 
            Every edge case we hit, we document. The factory improves itself.
          </p>
        </Reveal>

        <Divider />

        {/* ── The migration ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-6">
            The migration
          </h2>
        </Reveal>

        <Reveal delay={0.05}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mb-5">
            Kortix is infrastructure. The platform is not the point.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl mb-4">
            The point is the migration — from human-operated to AI-operated. From companies that 
            require constant human attention to keep running, to companies that run themselves and 
            only require human judgment to keep improving.
          </p>
        </Reveal>

        <Reveal delay={0.15}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            We think every serious company will make this migration in the next few years. 
            The ones that move early will be operating at a cost base and execution speed 
            that latecomers cannot catch. We are building the path — and walking it first.
          </p>
        </Reveal>

        <Divider />

        {/* ── Closing ── */}
        <Reveal>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mb-5">
            We are a small team. We care that the playbook is real, that it works, and that 
            every company we help run this way comes out the other side faster and leaner than 
            when they started.
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            If you want to build this with us —{' '}
            <Link
              href="/careers"
              className="text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors"
            >
              we&apos;re hiring.
            </Link>
            {' '}            If you want to run your company on it —{' '}
            <Link
              href="/partnerships"
              className="text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors"
            >
              reach out.
            </Link>
          </p>
        </Reveal>

      </article>
    </main>
  );
}
