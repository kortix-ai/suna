'use client';

import { Reveal } from '@/components/home/reveal';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

type Faq = { id: string; question: string; answer: string };

const FAQS: Faq[] = [
  {
    id: 'what-is-kortix',
    question: 'What is Kortix?',
    answer:
      'An open AI command center for your company. You give it work in plain language and it delivers finished output — a PR, a deck, a dashboard, a reply — by running real agents across your tools, not just chatting back.',
  },
  {
    id: 'how-different',
    question: 'How is it different from ChatGPT or a regular AI assistant?',
    answer:
      'A regular assistant lives inside someone else’s product and hands you suggestions. Kortix is your own workforce: open source, running on your infrastructure, connected to 3,000+ tools, shared across your team — and it returns finished, reviewable work.',
  },
  {
    id: 'open-source-self-host',
    question: 'Is it really open source? Can I self-host it?',
    answer:
      'Yes. The platform is open source — read it, fork it, audit it. Run it on our managed cloud, in your own cloud, or entirely on your own servers. Your data stays where you want it.',
  },
  {
    id: 'own-model',
    question: 'Can I use my own model or API key?',
    answer:
      'Yes. Bring any provider — Anthropic, OpenAI, Google, and more — routed per session. Your keys stay in Secrets and are injected into each sandbox at boot; you’re never locked to one provider.',
  },
  {
    id: 'company-as-repo',
    question: 'What does “your company is a Git repo” mean?',
    answer:
      'Your agents, skills, context, and memory are just files in one Git repo. Everything is versioned, auditable, and shareable — so changes are reviewable and nothing is a black box.',
  },
  {
    id: 'how-it-runs',
    question: 'How does it actually run my agents?',
    answer:
      'The Kortix Runtime (OpenCode) reads the files and spins up each task in its own isolated sandbox on its own branch. The work lands back as a reviewable change request into your repo.',
  },
  {
    id: 'where',
    question: 'Where can I use it?',
    answer:
      'The same agents and the same repo are reachable from the web/desktop app, Slack, Teams, your phone, or the CLI. Ask in a message; get the work back.',
  },
  {
    id: 'security',
    question: 'Is it secure and scoped?',
    answer:
      'Every session runs in an isolated sandbox with only the access it needs, credentials brokered instead of copied, and a full audit trail. Admins control what can run, what asks first, and what stays blocked.',
  },
  {
    id: 'get-started',
    question: 'How do I get started?',
    answer:
      'Start with one workflow, connect the tools it needs, and let your team use it from Slack, the web workspace, or the CLI. Self-host for free or use managed cloud — create your first coworker below.',
  },
];

export function Faq() {
  return (
    <section id="faq" className={sectionShell}>
      <Reveal>
        <div className="mx-auto mb-12 max-w-3xl space-y-3 text-center">
          <Badge variant="kortix" className="rounded">
            FAQ
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            Questions, answered.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed text-balance">
            The short version of what Kortix is, how it runs, and how to start.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="border-border bg-card mx-auto max-w-3xl overflow-hidden rounded-2xl border">
          <Accordion type="single" collapsible className="w-full">
            {FAQS.map((faq) => (
              <AccordionItem key={faq.id} value={faq.id} className="border-border/60 px-5 sm:px-6">
                <AccordionTrigger className="text-foreground py-5 text-base font-medium hover:no-underline">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-5 text-sm leading-relaxed sm:text-base">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </Reveal>
    </section>
  );
}

export default Faq;
