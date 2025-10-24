'use client';

import { IconRenderer } from '@/components/onboarding/shared/icon-renderer';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { useMemo } from 'react';

const allUsageCards = [
    {
        icon: 'Sparkles',
        title: 'Dev Portfolio',
        description: 'Auto-generate a dev portfolio.',
        prompt: 'Build a single-page portfolio from my GitHub readmes and pinned repos.'
    },
    {
        icon: 'CalendarPlus',
        title: 'Content Calendar',
        description: '90-day post plan.',
        prompt: 'Create a 90-day content calendar for TikTok + LinkedIn with hooks and CTAs.'
    },
    {
        icon: 'FileCode2',
        title: 'Readme Polisher',
        description: 'Make readmes pop.',
        prompt: 'Rewrite these README.md files with badges, gifs, and usage examples.'
    },
    {
        icon: 'PencilRuler',
        title: 'Brand Kit',
        description: 'Logo, palette, type.',
        prompt: 'Generate a lightweight brand kit with color tokens and typography scale.'
    },
    {
        icon: 'BarChart4',
        title: 'Cohort Analysis',
        description: 'Retention view.',
        prompt: 'Compute weekly cohort retention and plot W1–W12 with insights.'
    },
    {
        icon: 'ScrollText',
        title: 'SOP Writer',
        description: 'Repeatable playbooks.',
        prompt: 'Turn these steps into a clear SOP with roles, SLAs, and failure modes.'
    },
    {
        icon: 'SearchCode',
        title: 'Bug Repro Kit',
        description: 'Minimal repro repo.',
        prompt: 'Create a minimal reproducible example for this issue with failing test.'
    },
    {
        icon: 'PlugZap',
        title: 'API Wrapper',
        description: 'Tiny SDK fast.',
        prompt: 'Generate a TypeScript API client with typed endpoints and retry logic.'
    },
    {
        icon: 'Clapperboard',
        title: 'UGC Script',
        description: '30s ad beats.',
        prompt: 'Write 3 UGC scripts (hook–problem–solution–CTA) for this product.'
    },
    {
        icon: 'Table2',
        title: 'Pricing Matrix',
        description: 'Tiering that sells.',
        prompt: 'Propose Good/Better/Best pricing with feature matrix and guardrails.'
    },
    {
        icon: 'Building',
        title: 'Biz One-Pager',
        description: 'Investor-ready.',
        prompt: 'Draft a company one-pager: problem, solution, traction, team, ask.'
    },
    {
        icon: 'BookOpenText',
        title: 'Course Outline',
        description: 'From zero to ship.',
        prompt: 'Design a 6-week course syllabus with projects and assessments.'
    },
    {
        icon: 'Siren',
        title: 'Incident Runbook',
        description: 'When stuff breaks.',
        prompt: 'Create an incident response runbook with severity levels and comms.'
    },
    {
        icon: 'Binary',
        title: 'Regex Builder',
        description: 'Pattern wizard.',
        prompt: 'Generate regex + tests to validate international phone formats.'
    },
    {
        icon: 'Cpu',
        title: 'LLM Prompt Kit',
        description: 'Reusable templates.',
        prompt: 'Make a prompt library (system, few-shot, evals) for support macros.'
    },
    {
        icon: 'MapPin',
        title: 'Local SEO Pack',
        description: 'Rank in maps.',
        prompt: 'Create GMB posts, service pages, and citation list for a dentist.'
    },
    {
        icon: 'Gauge',
        title: 'Perf Audit',
        description: 'Crush Core Web Vitals.',
        prompt: 'Audit this site and output fixes for LCP, INP, CLS with PR plan.'
    },
    {
        icon: 'Wallet',
        title: 'Budget Template',
        description: 'Cashflow clarity.',
        prompt: 'Build a monthly budgeting sheet with categories and savings rules.'
    },
    {
        icon: 'Bot',
        title: 'Support Bot',
        description: 'Docs → bot.',
        prompt: 'Turn these FAQs into a retrieval-augmented chatbot with guardrails.'
    },
    {
        icon: 'LineChart',
        title: 'Funnel Report',
        description: 'Drop-off truths.',
        prompt: 'Assemble a signup funnel with stage conversion and biggest leaks.'
    },
    {
        icon: 'Brush',
        title: 'Landing Redesign',
        description: 'Above-the-fold win.',
        prompt: 'Rewrite hero, social proof, and CTA for 3 variants ready to A/B test.'
    },
    {
        icon: 'Flame',
        title: 'Email Warmup',
        description: 'From cold to gold.',
        prompt: 'Draft a 7-email cold sequence with personalization angles and bumps.'
    },
    {
        icon: 'Database',
        title: 'Schema Draft',
        description: 'Tables that scale.',
        prompt: 'Design a Postgres schema with indexes and sample queries for bookings.'
    },
    {
        icon: 'BookMarked',
        title: 'Reading Plan',
        description: '10 books, 10 weeks.',
        prompt: 'Curate a reading plan with summaries and discussion questions.'
    },
    {
        icon: 'Presentation',
        title: 'Sales Deck',
        description: 'Story that closes.',
        prompt: 'Create a 12-slide deck: pain, value, ROI math, objections, case study.'
    },
    {
        icon: 'Download',
        title: 'Lead Magnet',
        description: 'PDF that converts.',
        prompt: 'Write a 7-page checklist lead magnet + landing page copy.'
    },
    {
        icon: 'Mic',
        title: 'Podcast Brief',
        description: 'Episode in a box.',
        prompt: 'Outline a 30-min episode: segments, questions, ad reads, clips plan.'
    },
    {
        icon: 'Share2',
        title: 'Referral Engine',
        description: 'Users invite users.',
        prompt: 'Design a referral program with reward tiers and anti-gaming rules.'
    },
    {
        icon: 'QrCode',
        title: 'Onboarding Tour',
        description: 'First run joy.',
        prompt: 'Create a 5-step product tour with tooltips and success triggers.'
    },
    {
        icon: 'Camera',
        title: 'UGC Shotlist',
        description: 'Make it filmable.',
        prompt: 'Produce a shotlist + framing notes for iPhone product b-roll.'
    },
    {
        icon: 'BellDot',
        title: 'Alert Rules',
        description: 'No pager fatigue.',
        prompt: 'Define sane alert policies with thresholds and runbooks.'
    },
    {
        icon: 'ShieldCheck',
        title: 'Policy Pack',
        description: 'Security basics.',
        prompt: 'Write acceptable use, password, and vendor risk policies.'
    },
    {
        icon: 'PaintBucket',
        title: 'Color Tokens',
        description: 'Design system core.',
        prompt: 'Generate semantic color tokens with light/dark pairs and contrast.'
    },
    {
        icon: 'SquareCode',
        title: 'Component Library',
        description: 'Ship UI fast.',
        prompt: 'Spec 12 React components with API, states, and stories.'
    },
    {
        icon: 'FileSpreadsheet',
        title: 'Model Template',
        description: 'Investor-grade sheet.',
        prompt: 'Build a 3-statement financial model with scenarios and charts.'
    },
    {
        icon: 'Ship',
        title: 'Release Notes',
        description: 'Changelog that sings.',
        prompt: 'Turn commit history into crisp release notes + TL;DR.'
    },
    {
        icon: 'PieChart',
        title: 'Segmentation',
        description: 'Know your users.',
        prompt: 'Propose customer segments with JTBD and messaging per segment.'
    },
    {
        icon: 'Timer',
        title: 'Sprint Plan',
        description: 'Two-week roadmap.',
        prompt: 'Create a sprint plan with tickets, estimates, and acceptance criteria.'
    },
    {
        icon: 'Receipt',
        title: 'Offer Stack',
        description: 'Irresistible bundle.',
        prompt: 'Craft a core offer with bonuses, guarantees, and pricing anchors.'
    },
    {
        icon: 'ListChecks',
        title: 'QA Checklist',
        description: 'Catch regressions.',
        prompt: 'Write a release QA checklist with priority paths and edge cases.'
    },
    {
        icon: 'CircleDollarSign',
        title: 'Ad Angles',
        description: 'Hook bank.',
        prompt: 'Generate 20 ad angles with headlines and scroll-stoppers.'
    },
    {
        icon: 'Route',
        title: 'Park Day Plan',
        description: 'Beat the lines.',
        prompt: 'Optimize a Universal + MK route with LL windows and breaks.'
    },
    {
        icon: 'Vegan',
        title: 'Meal Prep',
        description: 'Macros made easy.',
        prompt: 'Plan 7-day meals (2k kcal) with shopping list and batch steps.'
    },
    {
        icon: 'HeartPulse',
        title: 'Study Notes',
        description: 'Paramedic core.',
        prompt: 'Condense these chapters into high-yield bullet notes + mnemonics.'
    },
    {
        icon: 'Rss',
        title: 'Trend Radar',
        description: 'What’s moving now.',
        prompt: 'Summarize top tech trends this week with actionable takes.'
    },
    {
        icon: 'GitBranch',
        title: 'Monorepo Plan',
        description: 'Nx/Turbo map.',
        prompt: 'Propose monorepo structure, caching, and CI pipeline.'
    },
    {
        icon: 'FolderGit2',
        title: 'CI Templates',
        description: 'Pipelines ready.',
        prompt: 'Create GitHub Actions for test, build, release, and versioning.'
    },
    {
        icon: 'Shirt',
        title: 'Merch Drop',
        description: 'Design + mockups.',
        prompt: 'Design 6 merch pieces with slogans and print specs.'
    },
    {
        icon: 'Lightbulb',
        title: 'Idea Expander',
        description: 'From seed to spec.',
        prompt: 'Take this idea and output user stories, risks, and v1 scope.'
    },
    {
        icon: 'Gamepad2',
        title: 'Microgame Jam',
        description: 'Playable in a day.',
        prompt: 'Design a one-level browser game with score loop and assets list.'
    },
    {
        icon: 'Map',
        title: 'City Guide',
        description: 'Eat, see, do.',
        prompt: 'Create a 48h city guide with routes, budgets, and maps.'
    },
    {
        icon: 'Newspaper',
        title: 'Press Kit',
        description: 'Media-ready.',
        prompt: 'Assemble founder bio, boilerplate, logos, and product shots.'
    },
    {
        icon: 'Globe',
        title: 'Landing i18n',
        description: 'Go global clean.',
        prompt: 'Localize this landing page into ES/FR/DE with cultural tweaks.'
    },
    {
        icon: 'Music',
        title: 'Soundtrack Brief',
        description: 'Vibes on cue.',
        prompt: 'Pick 10 tracks (royalty-free) per scene with timing notes.'
    },
    {
        icon: 'Wrench',
        title: 'Migration Plan',
        description: 'Zero-downtime.',
        prompt: 'Plan a DB migration with backfill, toggles, and rollback.'
    },
    {
        icon: 'Book',
        title: 'Playbook PDF',
        description: 'Sellable asset.',
        prompt: 'Turn this thread into a polished, designed 20-page playbook.'
    },
    {
        icon: 'FileSearch',
        title: 'Audit Sweep',
        description: 'Find the mess.',
        prompt: 'Audit SEO, analytics, and accessibility; prioritize top 10 fixes.'
    },
    {
        icon: 'Laptop',
        title: 'Interview Kit',
        description: 'Hire faster.',
        prompt: 'Create role scorecards, interview loops, and rubrics.'
    },
    {
        icon: 'Package',
        title: 'Offer Teardown',
        description: 'Steal what works.',
        prompt: 'Reverse-engineer 5 competitor offers; extract hooks and gaps.'
    },
    {
        icon: 'BadgeCheck',
        title: 'Case Study',
        description: 'Proof that sells.',
        prompt: 'Write a 1-page case study with before/after metrics and quotes.'
    },
    {
        icon: 'PieChart',
        title: 'CAC/LTV Model',
        description: 'Unit economics.',
        prompt: 'Calculate CAC/LTV by channel; show sensitivity table.'
    },
    {
        icon: 'TrendingUp',
        title: 'OKR Set',
        description: 'Aligned goals.',
        prompt: 'Draft quarterly OKRs with KRs and owner per team.'
    },
    {
        icon: 'Mail',
        title: 'Inbox Zero',
        description: 'Summarize + draft.',
        prompt: 'Summarize new emails and propose replies in my voice.'
    },
    {
        icon: 'BookCopy',
        title: 'Anki Maker',
        description: 'Cards from notes.',
        prompt: 'Convert these notes into cloze cards with tags and deck splits.'
    },
    {
        icon: 'Sofa',
        title: 'Airbnb Listing',
        description: 'Book more nights.',
        prompt: 'Rewrite listing title, description, amenities, and photo shotlist.'
    },
    {
        icon: 'PenSquare',
        title: 'Resume Revamp',
        description: 'ATS + punchy.',
        prompt: 'Rewrite my resume with quantified bullets and tailored summary.'
    },
    {
        icon: 'BookA',
        title: 'Language Drills',
        description: 'Daily 20-min.',
        prompt: 'Create spaced drills for Italian A2: verbs, cloze, audio prompts.'
    },
    {
        icon: 'Mic2',
        title: 'Clip Finder',
        description: 'Viral hooks.',
        prompt: 'Find 10 clipable moments and write titles + timestamps.'
    },
    {
        icon: 'ImageDown',
        title: 'Thumbnail Lab',
        description: 'CTR up.',
        prompt: 'Generate 6 thumbnail concepts with captions and focal points.'
    },
    {
        icon: 'LaptopMinimal',
        title: 'Notion OS',
        description: 'Life dashboard.',
        prompt: 'Build a Notion workspace for goals, tasks, content, CRM.'
    },
    {
        icon: 'FileBarChart',
        title: 'Investor Update',
        description: 'Tight monthly.',
        prompt: 'Draft a founder update with KPIs, asks, and wins.'
    },
    {
        icon: 'Ruler',
        title: 'UX Heuristics',
        description: 'Fix the rough.',
        prompt: 'Heuristic eval of signup flow; list issues + quick wins.'
    },
    {
        icon: 'TestTube',
        title: 'Experiment Map',
        description: 'Run smart tests.',
        prompt: 'Propose 10 growth experiments with H1, success metric, and cost.'
    },
    {
        icon: 'Store',
        title: 'Shop Setup',
        description: 'From zero to live.',
        prompt: 'Set up a Shopify catalog, collections, and checkout with apps list.'
    },
    {
        icon: 'Fish',
        title: 'Niche Ideas',
        description: 'Micro-markets.',
        prompt: 'List 25 niche product ideas with why-now and sourcing.'
    },
    {
        icon: 'MailPlus',
        title: 'Newsletter Kit',
        description: 'Week 1–12.',
        prompt: 'Plan 12 issues with themes, CTAs, and lead magnets.'
    },
    {
        icon: 'CheckCheck',
        title: 'Launch Checklist',
        description: 'No surprises.',
        prompt: 'Create a pre-launch checklist across product, legal, and GTM.'
    },
    {
        icon: 'Contact',
        title: 'CRM Playbook',
        description: 'Pipeline tidy.',
        prompt: 'Define CRM stages, exit criteria, and task automations.'
    }
];


interface UsageSectionProps {
    onCardClick?: (prompt: string) => void;
    maxCards?: number;
}

export function UsageSection({ onCardClick, maxCards = 8 }: UsageSectionProps) {
    // Randomly select cards on mount
    const selectedCards = useMemo(() => {
        const shuffled = [...allUsageCards].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, maxCards);
    }, [maxCards]);

    const handleCardClick = (description: string) => {
        if (onCardClick) {
            onCardClick(description);
        }
    };

    return (
        <section className="w-full py-16 md:py-24">
            <div className="container">
                {/* Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {selectedCards.map((card, index) => {
                        return (
                            <SpotlightCard
                                key={index}
                                className="border rounded-[24px] bg-background p-6 flex flex-col gap-4 cursor-pointer transition-colors"
                            >
                                <div
                                    onClick={() => handleCardClick(card.prompt)}
                                    className="flex flex-col gap-4"
                                >
                                    {/* Icon wrapper */}
                                    <div className='flex items-center gap-3'>
                                        <div className="w-10 h-10 rounded-[13px] border-[1.5px] bg-background flex items-center justify-center">
                                            <IconRenderer iconName={card.icon} size={20} />
                                        </div>
                                        <h3 className="text-xl font-medium">
                                            {card.title}
                                        </h3>
                                    </div>

                                    {/* Content */}
                                    <div className="flex flex-col gap-2">
                                        <p className="text-base font-medium opacity-70">
                                            {card.description}
                                        </p>
                                    </div>
                                </div>
                            </SpotlightCard>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
