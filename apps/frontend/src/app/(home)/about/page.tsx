'use client';

import Image from 'next/image';
import { SimpleFooter } from '@/components/home/simple-footer';
import { motion, useScroll, useMotionValueEvent } from 'framer-motion';
import { useRef, useState } from 'react';

const paragraphs = [
  "We're Kortix.",
  "Eight people across three continents. Some wake to European mornings, others to American dawns, a few greet the day from Asia. The sun never sets on our work. When one logs off, another picks up. A continuous stream that never stops.",
  "Our mission is to build a general AI worker that can truly take over real world tasks. Not a chatbot. Not a narrow tool. A worker that helps people save time and focus on what actually matters.",
  "We call ourselves a tribe.",
  "Not a team, not a company. A tribe. People bound by a shared obsession rather than geography or office walls.",
  "We don't believe in staying put. We travel year-round, working from new cities, new countries, new time zones. Movement keeps us sharp. New places bring new perspectives, and those perspectives feed directly into what we build.",
  "The culture is simple: ship fast, debate openly, let the best ideas win. No politics. No hierarchy of opinions. Just a relentless focus on making something that matters.",
  "We're not here for the hype cycle.",
  "We're building for the long game. A future where AI workers are infrastructure, not novelty.",
  "Let's push the game forward."
];

// Calculate total characters for proportional timing
const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);

// Calculate cumulative positions for each paragraph
const paragraphPositions = paragraphs.reduce<{ start: number; end: number }[]>((acc, paragraph, index) => {
  const prevEnd = index === 0 ? 0 : acc[index - 1].end;
  const proportion = paragraph.length / totalChars;
  acc.push({
    start: prevEnd,
    end: prevEnd + proportion
  });
  return acc;
}, []);

function TypewriterParagraph({ 
  text, 
  paragraphIndex,
  maxProgress 
}: { 
  text: string;
  paragraphIndex: number;
  maxProgress: number;
}) {
  const { start, end } = paragraphPositions[paragraphIndex];
  const characters = text.split('');
  
  return (
    <div className="relative">
      {/* Ghost text */}
      <p className="opacity-[0.12] select-none" aria-hidden="true">
        {text}
      </p>
      {/* Revealed text */}
      <p className="absolute inset-0">
        {characters.map((char, charIndex) => {
          // Calculate this character's position within the paragraph's scroll range
          const charProgress = charIndex / characters.length;
          const charStart = start + (end - start) * charProgress;
          const charEnd = start + (end - start) * ((charIndex + 1) / characters.length);
          
          return (
            <CharReveal 
              key={charIndex} 
              char={char}
              maxProgress={maxProgress}
              charStart={charStart}
              charEnd={charEnd}
            />
          );
        })}
      </p>
    </div>
  );
}

function CharReveal({ 
  char, 
  maxProgress,
  charStart,
  charEnd
}: { 
  char: string;
  maxProgress: number;
  charStart: number;
  charEnd: number;
}) {
  // Calculate opacity based on maxProgress (only increases, never decreases)
  let opacity = 0;
  if (maxProgress >= charEnd) {
    opacity = 1;
  } else if (maxProgress > charStart) {
    // Partial reveal - smooth interpolation
    opacity = (maxProgress - charStart) / (charEnd - charStart);
  }

  return (
    <span 
      style={{ opacity }}
      className="transition-opacity duration-100"
    >
      {char}
    </span>
  );
}

export default function AboutPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxProgress, setMaxProgress] = useState(0);
  
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start 0.3", "end 0.5"]
  });

  // Track the maximum scroll progress reached (only increases, never decreases)
  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    setMaxProgress(prev => Math.max(prev, latest));
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
          {paragraphs.map((text, index) => (
            <TypewriterParagraph 
              key={index} 
              text={text}
              paragraphIndex={index}
              maxProgress={maxProgress}
            />
          ))}
        </div>

      </article>

      <SimpleFooter />
    </main>
  );
}
