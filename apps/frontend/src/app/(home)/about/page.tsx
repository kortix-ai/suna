'use client';

import Image from 'next/image';
import Link from 'next/link';
import { SimpleFooter } from '@/components/home/simple-footer';
import { motion, useScroll, useMotionValueEvent } from 'framer-motion';
import { useRef, useState } from 'react';

type ParagraphItem = 
  | string 
  | { text: string; linkText: string; linkHref: string };

const paragraphs: ParagraphItem[] = [
  "We are Kortix.",
  "Eight people across three continents. Some wake to European mornings, others to American dawns, a few greet the day from Asia. The sun never sets on our work. When one logs off, another picks up. A continuous stream that never stops.",
  "Our mission is to build a general AI worker that can truly take over real world tasks. Not a chatbot. Not a narrow tool. A worker that helps people save time and focus on what actually matters.",
  "We are essentially a tribe.",
  "People bound by a shared obsession rather than geography or office walls.",
  "We don't believe in staying put. We travel year-round, working from new cities, new countries, new time zones. Movement keeps us sharp. New places bring new perspectives, and those perspectives feed directly into what we build.",
  "The culture is simple: ship fast, debate openly, let the best ideas win. No politics. No hierarchy of opinions. Just a relentless focus on making something that matters.",
  "We're not here for the hype cycle.",
  "We're building for the long game. A future where AI workers are infrastructure, not novelty.",
  { text: "Let's push the game forward. ", linkText: "Join us.", linkHref: "/careers" }
];

// Helper to get text content from paragraph item
const getParagraphText = (p: ParagraphItem): string => 
  typeof p === 'string' ? p : p.text + p.linkText;

// Calculate total characters for proportional timing
const totalChars = paragraphs.reduce((sum, p) => sum + getParagraphText(p).length, 0);

// Calculate cumulative positions for each paragraph
const paragraphPositions = paragraphs.reduce<{ start: number; end: number }[]>((acc, paragraph, index) => {
  const prevEnd = index === 0 ? 0 : acc[index - 1].end;
  const proportion = getParagraphText(paragraph).length / totalChars;
  acc.push({
    start: prevEnd,
    end: prevEnd + proportion
  });
  return acc;
}, []);

function TypewriterParagraph({ 
  paragraph, 
  paragraphIndex,
  progress,
  isLocked
}: { 
  paragraph: ParagraphItem;
  paragraphIndex: number;
  progress: number;
  isLocked: boolean;
}) {
  const { start, end } = paragraphPositions[paragraphIndex];
  const isLinkedParagraph = typeof paragraph !== 'string';
  const fullText = getParagraphText(paragraph);
  const characters = fullText.split('');
  
  // For linked paragraphs, find where the link starts
  const linkStartIndex = isLinkedParagraph ? paragraph.text.length : -1;
  
  const renderCharacters = (chars: string[], startIdx: number) => 
    chars.map((char, i) => {
      const charIndex = startIdx + i;
      const charProgress = charIndex / characters.length;
      const charStart = start + (end - start) * charProgress;
      const charEnd = start + (end - start) * ((charIndex + 1) / characters.length);
      
      return (
        <CharReveal 
          key={charIndex} 
          char={char}
          progress={progress}
          charStart={charStart}
          charEnd={charEnd}
          isLocked={isLocked}
        />
      );
    });
  
  return (
    <div className="relative">
      {/* Ghost text */}
      <p className="opacity-[0.12] select-none" aria-hidden="true">
        {isLinkedParagraph ? (
          <>
            {paragraph.text}
            <span className="opacity-50">{paragraph.linkText}</span>
          </>
        ) : fullText}
      </p>
      {/* Revealed text */}
      <p className="absolute inset-0">
        {isLinkedParagraph ? (
          <>
            {renderCharacters(paragraph.text.split(''), 0)}
            <Link 
              href={paragraph.linkHref} 
              className="opacity-50 hover:opacity-100 transition-opacity"
            >
              {renderCharacters(paragraph.linkText.split(''), linkStartIndex)}
            </Link>
          </>
        ) : (
          renderCharacters(characters, 0)
        )}
      </p>
    </div>
  );
}

function CharReveal({ 
  char, 
  progress,
  charStart,
  charEnd,
  isLocked
}: { 
  char: string;
  progress: number;
  charStart: number;
  charEnd: number;
  isLocked: boolean;
}) {
  // If animation is locked (completed), always show full opacity
  if (isLocked) {
    return <span>{char}</span>;
  }
  
  // Calculate opacity based on current progress (reversible)
  let opacity = 0;
  if (progress >= charEnd) {
    opacity = 1;
  } else if (progress > charStart) {
    // Partial reveal - smooth interpolation
    opacity = (progress - charStart) / (charEnd - charStart);
  }

  return (
    <span 
      style={{ opacity }}
      className="transition-opacity duration-75"
    >
      {char}
    </span>
  );
}

export default function AboutPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentProgress, setCurrentProgress] = useState(0);
  const [isLocked, setIsLocked] = useState(false);
  
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start 0.3", "end 0.5"]
  });

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    // If already locked, don't update anything
    if (isLocked) return;
    
    // Update current progress (allows reversing)
    setCurrentProgress(latest);
    
    // Lock when animation completes (reached 95% or more)
    if (latest >= 0.95) {
      setIsLocked(true);
      setCurrentProgress(1); // Ensure fully revealed
    }
  });

  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-4xl mx-auto px-6 md:px-10 pt-24 md:pt-28 pb-32">
        
        {/* Hero Image */}
        <motion.figure 
          className="mb-16 md:mb-20"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="relative aspect-[16/9] w-full overflow-hidden">
            <Image
              src="/images/team.webp"
              alt="The Kortix team"
              fill
              className="object-cover object-top"
              priority
            />
          </div>
        </motion.figure>

        <div 
          ref={containerRef}
          className="text-foreground text-[1.375rem] md:text-[1.5rem] leading-[1.6] tracking-[-0.025em] font-medium space-y-7"
        >
          {paragraphs.map((paragraph, index) => (
            <TypewriterParagraph 
              key={index} 
              paragraph={paragraph}
              paragraphIndex={index}
              progress={currentProgress}
              isLocked={isLocked}
            />
          ))}
        </div>

        {/* Passport with Travel Stamps */}
        <div className="mt-24 md:mt-32">
          {/* Mobile: Single page with stacked stamps */}
          <div className="md:hidden border border-foreground/10 rounded-sm p-6">
            {/* Visas header */}
            <div className="text-center mb-6">
              <span className="text-xs uppercase tracking-[0.3em] text-foreground/40 font-medium">Visas</span>
            </div>
            
            {/* Stamps grid - 2 columns on mobile */}
            <div className="grid grid-cols-2 gap-4 place-items-center">
              {/* Belgrade */}
              <div className="rotate-[-8deg] opacity-70 [filter:grayscale(100%)]">
                <Image src="/images/stamps/bg.svg" alt="Belgrade stamp" width={120} height={78} className="w-[120px]" />
              </div>
              {/* Lisbon */}
              <div className="rotate-[12deg] opacity-70 [filter:grayscale(100%)]">
                <Image src="/images/stamps/lisbon.svg" alt="Lisbon stamp" width={110} height={71} className="w-[110px]" />
              </div>
              {/* NYC */}
              <div className="rotate-[-5deg] opacity-70 [filter:grayscale(100%)]">
                <Image src="/images/stamps/nyc.svg" alt="New York City stamp" width={130} height={84} className="w-[130px]" />
              </div>
              {/* San Francisco */}
              <div className="rotate-[6deg] opacity-70 [filter:grayscale(100%)]">
                <Image src="/images/stamps/sf.svg" alt="San Francisco stamp" width={115} height={75} className="w-[115px]" />
              </div>
              {/* London */}
              <div className="rotate-[8deg] opacity-70 [filter:grayscale(100%)]">
                <Image src="/images/stamps/london.svg" alt="London stamp" width={115} height={75} className="w-[115px]" />
              </div>
              {/* Malaga */}
              <div className="rotate-[-10deg] opacity-70 [filter:grayscale(100%)]">
                <Image src="/images/stamps/malaga.svg" alt="Malaga stamp" width={130} height={84} className="w-[130px]" />
              </div>
              {/* Bali */}
              <div className="rotate-[10deg] opacity-70 [filter:grayscale(100%)]">
                <Image src="/images/stamps/bali.svg" alt="Bali stamp" width={100} height={100} className="w-[100px]" />
              </div>
            </div>

            {/* Kortix logo */}
            <div className="text-center mt-6">
              <Image src="/kortix-symbol.svg" alt="Kortix" width={16} height={13} className="inline-block opacity-20 dark:invert" />
            </div>
          </div>

          {/* Desktop: Two-page spread */}
          <div className="hidden md:grid grid-cols-2 border border-foreground/10 rounded-sm">
            {/* Left Page */}
            <div className="relative border-r border-foreground/10 p-6 flex flex-col aspect-[3/4]">
              {/* Visas header */}
              <div className="text-center mb-4">
                <span className="text-xs uppercase tracking-[0.3em] text-foreground/40 font-medium">Visas</span>
              </div>
              
              {/* Stamps on left page */}
              <div className="relative flex-1">
                {/* Belgrade */}
                <div className="absolute left-[5%] top-[2%] rotate-[-12deg] opacity-60 hover:opacity-90 transition-all duration-300 [filter:grayscale(100%)] hover:[filter:grayscale(0%)_sepia(100%)_hue-rotate(320deg)_saturate(300%)_brightness(0.9)]">
                  <Image src="/images/stamps/bg.svg" alt="Belgrade stamp" width={160} height={104} className="w-[160px]" />
                </div>
                {/* Lisbon */}
                <div className="absolute right-[0%] top-[0%] rotate-[15deg] opacity-65 hover:opacity-95 transition-all duration-300 [filter:grayscale(100%)] hover:[filter:grayscale(0%)_sepia(100%)_hue-rotate(90deg)_saturate(400%)_brightness(0.85)]">
                  <Image src="/images/stamps/lisbon.svg" alt="Lisbon stamp" width={145} height={94} className="w-[145px]" />
                </div>
                {/* NYC */}
                <div className="absolute left-[0%] bottom-[25%] rotate-[-7deg] opacity-70 hover:opacity-100 transition-all duration-300 z-10 [filter:grayscale(100%)] hover:[filter:grayscale(0%)_sepia(100%)_hue-rotate(130deg)_saturate(500%)_brightness(0.85)]">
                  <Image src="/images/stamps/nyc.svg" alt="New York City stamp" width={175} height={114} className="w-[175px]" />
                </div>
                {/* San Francisco */}
                <div className="absolute right-[0%] bottom-[0%] rotate-[8deg] opacity-65 hover:opacity-95 transition-all duration-300 [filter:grayscale(100%)] hover:[filter:grayscale(0%)_sepia(100%)_hue-rotate(180deg)_saturate(400%)_brightness(0.9)]">
                  <Image src="/images/stamps/sf.svg" alt="San Francisco stamp" width={150} height={97} className="w-[150px]" />
                </div>
              </div>

              {/* Kortix logo */}
              <div className="text-center mt-4">
                <Image src="/kortix-symbol.svg" alt="Kortix" width={16} height={13} className="inline-block opacity-20 dark:invert" />
              </div>
            </div>

            {/* Right Page */}
            <div className="relative p-6 flex flex-col aspect-[3/4]">
              {/* Visas header */}
              <div className="text-center mb-4">
                <span className="text-xs uppercase tracking-[0.3em] text-foreground/40 font-medium">Visas</span>
              </div>
              
              {/* Stamps on right page */}
              <div className="relative flex-1">
                {/* London */}
                <div className="absolute left-[0%] top-[0%] rotate-[11deg] opacity-60 hover:opacity-90 transition-all duration-300 [filter:grayscale(100%)] hover:[filter:grayscale(0%)_sepia(100%)_hue-rotate(330deg)_saturate(350%)_brightness(0.9)]">
                  <Image src="/images/stamps/london.svg" alt="London stamp" width={150} height={97} className="w-[150px]" />
                </div>
                {/* Malaga */}
                <div className="absolute right-[-5%] top-[12%] rotate-[-14deg] opacity-65 hover:opacity-95 transition-all duration-300 [filter:grayscale(100%)] hover:[filter:grayscale(0%)_sepia(100%)_hue-rotate(350deg)_saturate(400%)_brightness(0.95)]">
                  <Image src="/images/stamps/malaga.svg" alt="Malaga stamp" width={170} height={110} className="w-[170px]" />
                </div>
                {/* Bali */}
                <div className="absolute left-[15%] bottom-[8%] rotate-[13deg] opacity-60 hover:opacity-90 transition-all duration-300 [filter:grayscale(100%)] hover:[filter:grayscale(0%)_sepia(100%)_hue-rotate(30deg)_saturate(350%)_brightness(0.95)]">
                  <Image src="/images/stamps/bali.svg" alt="Bali stamp" width={130} height={130} className="w-[130px]" />
                </div>
              </div>

              {/* Kortix logo */}
              <div className="text-center mt-4">
                <Image src="/kortix-symbol.svg" alt="Kortix" width={16} height={13} className="inline-block opacity-20 dark:invert" />
              </div>
            </div>
          </div>
        </div>

      </article>

      <SimpleFooter />
    </main>
  );
}
