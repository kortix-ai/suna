'use client';

import { type MotionValue, m, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useRef } from 'react';
import { statement } from './content';

/**
 * A chapter break: one sentence, pinned, that reads itself in as the page
 * scrolls. Each word goes from faint to full as the reader passes it. Reduced
 * motion gets the sentence at full strength and no pin.
 */
export function Statement() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 70%', 'end end'] });
  const words = statement.split(' ');

  if (reduceMotion) {
    return (
      <section className="mx-auto max-w-5xl px-6 py-24 text-center md:py-30">
        <p className="text-foreground text-3xl font-normal tracking-tight text-balance sm:text-5xl">{statement}</p>
      </section>
    );
  }

  return (
    <div ref={ref} className="relative h-[150svh]">
      <section className="sticky top-0 flex h-svh items-center justify-center px-6">
        <p className="text-foreground max-w-5xl text-center text-3xl font-normal tracking-tight text-balance sm:text-5xl">
          {words.map((word, i) => (
            <Word key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]}>
              {word}
            </Word>
          ))}
        </p>
      </section>
    </div>
  );
}

function Word({
  progress,
  range,
  children,
}: {
  progress: MotionValue<number>;
  range: [number, number];
  children: string;
}) {
  const opacity = useTransform(progress, range, [0.15, 1]);
  return (
    <>
      <m.span style={{ opacity }}>{children}</m.span>{' '}
    </>
  );
}
