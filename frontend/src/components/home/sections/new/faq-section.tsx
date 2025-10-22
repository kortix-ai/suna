'use client';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { GrainText } from '@/components/ui/grain-text';

const faqs = [
    {
        id: '1',
        question: 'What is Kortix?',
        answer: 'An AI workspace and control plane that treats Office artifacts (Slides/PowerPoint, Sheets/Excel, Docs/Word, email) as both the output and the UI. You speak in natural language; it ships client-ready decks, models, docs, and emails in your templates.',
    },
    {
        id: '2',
        question: 'How is Kortix different from chatbots or "copilots"?',
        answer: 'Instead of just generating text or suggestions, Kortix autonomously handles complete workflows—from research and analysis to producing final deliverables in your company\'s formats. It works as a true workspace where documents are the interface, not a side tool.',
    },
    {
        id: '3',
        question: 'What can it do today—and how fast?',
        answer: 'Kortix can build financial models, pitch decks, market research reports, and client emails in minutes instead of hours. It connects to your data sources, runs analyses, and outputs polished deliverables—all while you focus on strategy and decision-making.',
    },
    {
        id: '4',
        question: 'How does it use my data, permissions, and tools?',
        answer: 'Kortix operates within your existing permissions framework. It only accesses data you authorize, uses your authenticated tools and APIs, and maintains enterprise-grade security. All processing respects your data residency and compliance requirements.',
    },
    {
        id: '5',
        question: 'Can I cancel or change plans anytime?',
        answer: 'Yes, you have full flexibility. Change plans, pause, or cancel anytime—no long-term commitments. Your data remains yours, and you can export everything before leaving.',
    },
];

export function FAQSection() {
    return (
        <section className="w-full py-16 md:py-24 lg:py-32">
            <div className="container px-4 md:px-6 max-w-4xl mx-auto">
                {/* Title */}
                <h2 className="text-xl font-medium mb-3">
                    Frequently Asked Questions
                </h2>

                {/* Description */}
                <GrainText className="text-base text-muted-foreground/60 mb-8 block" grainOpacity={100}>
                    Everything you need to know about Kortix
                </GrainText>

                {/* Accordion */}
                <Accordion type="single" collapsible className="w-full">
                    {faqs.map((faq) => (
                        <AccordionItem key={faq.id} value={faq.id} className="border-b border-border/40">
                            <AccordionTrigger className="text-base font-medium hover:no-underline py-5 cursor-pointer">
                                {faq.question}
                            </AccordionTrigger>
                            <AccordionContent className="text-sm text-muted-foreground/80 leading-relaxed pb-5">
                                {faq.answer}
                            </AccordionContent>
                        </AccordionItem>
                    ))}
                </Accordion>
            </div>
        </section>
    );
}
