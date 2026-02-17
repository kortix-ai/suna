'use client';

import { useState, useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import { SimpleFooter } from '@/components/home/simple-footer';
import { Button } from '@/components/ui/button';
import { KortixEnterpriseModal } from '@/components/sidebar/kortix-enterprise-modal';
import {
  ArrowRight,
  ArrowDown,
  Search,
  Wrench,
  RefreshCw,
  Rocket,
  ChevronDown,
} from 'lucide-react';

// Shared subtle fade
const fade = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: i * 0.08, ease: [0.25, 0.46, 0.45, 0.94] },
  }),
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

// --- Hero ---
function HeroSection() {
  return (
    <section className="relative w-full min-h-[85vh] flex items-center overflow-hidden">
      <div className="absolute inset-0 bg-pattern-grid opacity-40" />
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background/80 to-background" />

      <div className="relative z-10 max-w-4xl mx-auto w-full px-6 py-32 md:py-40">
        <motion.h1
          className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-medium tracking-tighter text-balance leading-[1.08]"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          Your company&apos;s
          <br />
          second cortex.
        </motion.h1>

        <motion.p
          className="mt-6 md:mt-8 text-base sm:text-lg md:text-xl text-muted-foreground max-w-2xl leading-relaxed text-balance"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.12, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          We embed with your team to design, build, and deploy custom Kortix
          instances — tailored to your workflows, connected to your tools,
          running 24/7. From scoping to production in weeks, not months.
        </motion.p>

        <motion.div
          className="mt-8 md:mt-10 flex flex-col sm:flex-row items-start sm:items-center gap-4"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.24, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          <KortixEnterpriseModal>
            <Button size="lg" className="text-base px-8 h-12 rounded-full">
              Schedule a consultation
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </KortixEnterpriseModal>

          <a
            href="#how"
            className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            See how it works
            <ArrowDown className="w-4 h-4" />
          </a>
        </motion.div>
      </div>
    </section>
  );
}

// --- Logo Marquee ---
const logos = [
  'Y Combinator',
  'Sequoia',
  'a16z',
  'Accel',
  'Index Ventures',
  'Greylock',
  'Benchmark',
  'Lightspeed',
];

function LogoMarquee() {
  return (
    <section className="w-full border-t border-border overflow-hidden py-8 md:py-10">
      <p className="text-center text-xs text-muted-foreground/50 uppercase tracking-[0.2em] font-medium mb-6">
        Trusted by teams backed by
      </p>
      <div
        className="relative overflow-hidden"
        style={
          {
            maskImage:
              'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
            WebkitMaskImage:
              'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
          } as React.CSSProperties
        }
      >
        <div
          className="flex overflow-hidden"
          style={
            {
              '--duration': '25s',
              '--gap': '3rem',
              gap: 'var(--gap)',
            } as React.CSSProperties
          }
        >
          {[0, 1].map((copy) => (
            <div
              key={copy}
              className="flex shrink-0 justify-around animate-marquee"
              style={{ gap: 'var(--gap)' } as React.CSSProperties}
              aria-hidden={copy === 1}
            >
              {logos.map((name) => (
                <span
                  key={`${copy}-${name}`}
                  className="text-base md:text-lg font-semibold tracking-tight text-muted-foreground/30 whitespace-nowrap select-none"
                >
                  {name}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// --- What We Do ---
function WhatWeDoSection() {
  const pillars = [
    {
      icon: <Search className="w-5 h-5" />,
      title: 'Discover',
      description:
        'We audit your operations, map every workflow, and identify where autonomous agents create the most leverage.',
    },
    {
      icon: <Wrench className="w-5 h-5" />,
      title: 'Build',
      description:
        'We architect your Kortix instance from the ground up — custom agents, your integrations, your data — running 24/7.',
    },
    {
      icon: <RefreshCw className="w-5 h-5" />,
      title: 'Operate',
      description:
        "We don't hand off and disappear. Your instance is continuously monitored, optimized, and expanded as your needs evolve.",
    },
  ];

  return (
    <section id="how" className="w-full border-t border-border scroll-mt-16">
      <div className="max-w-4xl mx-auto px-6 py-20 md:py-28">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          variants={stagger}
          className="space-y-4 mb-14"
        >
          <motion.h2
            variants={fade}
            custom={0}
            className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-balance"
          >
            We build your AI workforce.
          </motion.h2>
          <motion.p
            variants={fade}
            custom={1}
            className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-3xl"
          >
            Kortix Enterprise is a fully managed engagement. Our team works
            inside your organization to architect, deploy, and maintain a
            custom Kortix instance — a persistent AI operating system that runs
            your workflows autonomously.
          </motion.p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border rounded-2xl overflow-hidden border border-border"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-40px' }}
          variants={stagger}
        >
          {pillars.map((pillar, i) => (
            <motion.div
              key={pillar.title}
              variants={fade}
              custom={i}
              className="bg-background p-8 space-y-3"
            >
              <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center text-foreground">
                {pillar.icon}
              </div>
              <h3 className="text-lg font-semibold tracking-tight">
                {pillar.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {pillar.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

// --- Timeline with IG-story progress dashes ---
const timelineSteps = [
  {
    week: 'Week 1–2',
    phase: 'Discovery',
    icon: <Search className="w-5 h-5" />,
    description:
      'We map your workflows, integrations, and team structure. We identify the highest-leverage agent deployments and define the architecture.',
    details: ['Workflow audit', 'Integration mapping', 'Architecture definition'],
  },
  {
    week: 'Week 3–5',
    phase: 'Build & Configure',
    icon: <Wrench className="w-5 h-5" />,
    description:
      'We build your Kortix instance — agents, skills, triggers, integrations, secrets management. Everything configured and tested against real workflows.',
    details: ['Agent development', 'Integration wiring', 'End-to-end testing'],
  },
  {
    week: 'Week 6+',
    phase: 'Deploy & Scale',
    icon: <Rocket className="w-5 h-5" />,
    description:
      'Your Kortix goes live. We monitor, iterate, and expand. New agents and skills get added as your needs grow.',
    details: ['Production deployment', 'Monitoring', 'Ongoing expansion'],
  },
];

function StoryDash({
  index,
  scrollYProgress,
  count,
}: {
  index: number;
  scrollYProgress: ReturnType<typeof useScroll>['scrollYProgress'];
  count: number;
}) {
  const segStart = index / count;
  const segEnd = (index + 1) / count;
  const fill = useTransform(scrollYProgress, [segStart, segEnd], ['0%', '100%']);

  return (
    <div className="flex-1 h-[3px] rounded-full bg-foreground/8 overflow-hidden">
      <motion.div
        className="h-full rounded-full bg-foreground/30"
        style={{ width: fill }}
      />
    </div>
  );
}

function TimelineSection() {
  const count = timelineSteps.length;
  const sectionRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end'],
  });

  return (
    <section
      ref={sectionRef}
      className="relative border-t border-border"
      style={{ height: `${count * 100}vh` }}
    >
      <div className="sticky top-0 h-screen flex flex-col overflow-hidden max-w-4xl mx-auto w-full px-6">
        {/* Heading */}
        <div className="flex-shrink-0 pt-16 md:pt-20">
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-balance">
            Live in weeks. Not quarters.
          </h2>
        </div>

        {/* Card area */}
        <div className="flex-1 relative mt-6 mb-6 flex items-center">
          {timelineSteps.map((step, i) => (
            <StepCard
              key={step.phase}
              step={step}
              index={i}
              count={count}
              scrollYProgress={scrollYProgress}
            />
          ))}
        </div>

        {/* Story dashes */}
        <div className="flex-shrink-0 pb-10 md:pb-12">
          <div className="flex gap-2">
            {timelineSteps.map((step, i) => (
              <StoryDash
                key={step.phase}
                index={i}
                scrollYProgress={scrollYProgress}
                count={count}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function StepCard({
  step,
  index,
  count,
  scrollYProgress,
}: {
  step: (typeof timelineSteps)[number];
  index: number;
  count: number;
  scrollYProgress: ReturnType<typeof useScroll>['scrollYProgress'];
}) {
  const segStart = index / count;
  const segEnd = (index + 1) / count;
  const mid = segStart + 0.03;
  const fadeOut = segEnd - 0.03;

  const opacity =
    index === 0
      ? useTransform(scrollYProgress, [0, fadeOut, segEnd], [1, 1, 0])
      : index === count - 1
        ? useTransform(scrollYProgress, [segStart, mid, 1], [0, 1, 1])
        : useTransform(scrollYProgress, [segStart, mid, fadeOut, segEnd], [0, 1, 1, 0]);

  const y =
    index === 0
      ? useTransform(scrollYProgress, [0, 0.01], [0, 0])
      : useTransform(scrollYProgress, [segStart, mid], [24, 0]);

  return (
    <motion.div
      className="absolute inset-x-0 top-1/2 -translate-y-1/2"
      style={{ opacity, y }}
    >
      <div className="rounded-2xl border border-border bg-background px-8 py-8 md:px-10 md:py-10 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center text-foreground flex-shrink-0">
            {step.icon}
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60">
            {step.week}
          </span>
        </div>

        <h3 className="text-2xl md:text-3xl font-semibold tracking-tight">
          {step.phase}
        </h3>

        <p className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-2xl">
          {step.description}
        </p>

        <div className="flex flex-wrap gap-2 pt-2">
          {step.details.map((d) => (
            <span
              key={d}
              className="text-xs font-medium text-foreground/60 bg-accent/60 px-3 py-1.5 rounded-lg"
            >
              {d}
            </span>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// --- FAQ ---
function FAQItem({
  question,
  answer,
  index,
}: {
  question: string;
  answer: string;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div variants={fade} custom={index} className="border-b border-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full py-5 text-left group cursor-pointer"
      >
        <span className="text-base font-medium tracking-tight pr-4 group-hover:text-foreground transition-colors">
          {question}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          open ? 'max-h-96 pb-5' : 'max-h-0'
        }`}
      >
        <p className="text-sm text-muted-foreground leading-relaxed pr-8">
          {answer}
        </p>
      </div>
    </motion.div>
  );
}

function FAQSection() {
  const faqs = [
    {
      question: 'How long does a typical engagement take?',
      answer:
        'Most companies are live within 4–6 weeks. Discovery takes 1–2 weeks, build takes 2–3 weeks, and deployment is ongoing with continuous optimization.',
    },
    {
      question: 'What does it cost?',
      answer:
        'Every engagement is scoped based on complexity, number of agents, and integration depth. We work on monthly retainers. Get in touch for a quote.',
    },
    {
      question: 'Do we need technical staff on our end?',
      answer:
        'No. We handle everything — architecture, deployment, integration, and maintenance. Your team just needs to show us how the company operates.',
    },
    {
      question: 'Can we self-host?',
      answer:
        'Yes. Kortix instances can run in our cloud or on your own infrastructure. We configure either path.',
    },
    {
      question: 'What AI models does Kortix use?',
      answer:
        'Kortix is built on Claude Code architecture. Agents run on the latest Anthropic models with full tool use, file system access, and persistent memory.',
    },
  ];

  return (
    <section className="w-full border-t border-border">
      <div className="max-w-3xl mx-auto px-6 py-20 md:py-28">
        <motion.h2
          className="text-3xl md:text-4xl font-medium tracking-tighter text-balance mb-10"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-40px' }}
          variants={fade}
          custom={0}
        >
          Frequently asked questions
        </motion.h2>
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-40px' }}
          variants={stagger}
        >
          {faqs.map((faq, i) => (
            <FAQItem
              key={i}
              question={faq.question}
              answer={faq.answer}
              index={i}
            />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

// --- CTA ---
function CTASection() {
  return (
    <section className="w-full border-t border-border">
      <div className="max-w-3xl mx-auto px-6 py-24 md:py-32 text-center">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          variants={stagger}
          className="space-y-6"
        >
          <motion.h2
            variants={fade}
            custom={0}
            className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-balance"
          >
            Let&apos;s build your second cortex.
          </motion.h2>
          <motion.p
            variants={fade}
            custom={1}
            className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed"
          >
            Every engagement starts with a conversation. Tell us about your
            company, your workflows, and where you need leverage — we&apos;ll
            show you what Kortix can do.
          </motion.p>
          <motion.div
            variants={fade}
            custom={2}
            className="pt-4 flex flex-col items-center gap-4"
          >
            <KortixEnterpriseModal>
              <Button size="lg" className="text-base px-8 h-12 rounded-full">
                Schedule a consultation
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </KortixEnterpriseModal>
            <p className="text-sm text-muted-foreground">
              Or email us directly at{' '}
              <a
                href="mailto:enterprise@kortix.ai"
                className="text-foreground hover:underline underline-offset-4 transition-colors"
              >
                enterprise@kortix.ai
              </a>
            </p>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

// --- Page ---
export default function EnterprisePage() {
  return (
    <main className="min-h-screen bg-background">
      <HeroSection />
      <LogoMarquee />
      <WhatWeDoSection />
      <TimelineSection />
      <FAQSection />
      <CTASection />
      <SimpleFooter />
    </main>
  );
}
