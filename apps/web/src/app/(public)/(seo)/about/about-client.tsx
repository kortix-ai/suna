'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Reveal } from '@/components/home/reveal';

type ParagraphItem = 
  | string 
  | { text: string; linkText: string; linkHref: string };

const paragraphs: ParagraphItem[] = [
  "We build self-driving companies.",
  "We're building the number one team in the world for autonomous operations. 76% agents, 24% humans — where humans verify, steer, and govern. Agents do the work.",
  "We take process-heavy companies and turn them into AI-operated ones. Full agent teams doing engineering, product, operations, finance, support, and growth. We run our own companies on it. Highest conviction comes from highest exposure.",
  "Kortix is the foundation. But the platform isn't the point. What matters is the migration — from human-operated to AI-operated. We're proving it works by doing it ourselves, every day.",
  { text: "Come build with us. ", linkText: "We're hiring.", linkHref: "/careers" }
];

export default function AboutPageClient() {
  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32 pb-24 sm:pb-32">
        
        {/* Hero Image */}
        <Reveal>
          <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg mb-14">
            <Image
              src="/images/team.webp"
              alt="The Kortix team"
              fill
              className="object-cover object-top"
              priority
            />
          </div>
        </Reveal>

        <div className="space-y-5">
          {paragraphs.map((paragraph, index) => (
            <Reveal key={index} delay={index * 0.08}>
              <p className="text-base text-muted-foreground leading-relaxed">
                {typeof paragraph === 'string' ? (
                  paragraph
                ) : (
                  <>
                    {paragraph.text}
                    <Link
                      href={paragraph.linkHref}
                      className="text-foreground font-medium underline underline-offset-4 decoration-foreground/40 hover:decoration-foreground transition-colors"
                    >
                      {paragraph.linkText}
                    </Link>
                  </>
                )}
              </p>
            </Reveal>
          ))}
        </div>

      </article>
    </main>
  );
}
