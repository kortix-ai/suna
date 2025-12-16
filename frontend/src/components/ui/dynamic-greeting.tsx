'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// Module-level cache - computed once per session on client only
let cachedGreeting: string | null = null;

function generateGreeting(t: ReturnType<typeof useTranslations<'dashboard'>>): string {
  const hour = new Date().getHours();

  const morningGreetings = [
    t('greetings.morning.0'),
    t('greetings.morning.1'),
    t('greetings.morning.2'),
  ];

  const afternoonGreetings = [
    t('greetings.afternoon.0'),
    t('greetings.afternoon.1'),
  ];

  const eveningGreetings = [
    t('greetings.evening.0'),
    t('greetings.evening.1'),
    t('greetings.evening.2'),
  ];

  const randomGreetings = [
    t('greetings.random.0'),
    t('greetings.random.1'),
    t('greetings.random.2'),
    t('greetings.random.3'),
    t('greetings.random.4'),
    t('greetings.random.5'),
    t('greetings.random.6'),
    t('greetings.random.7'),
    t('greetings.random.8'),
    t('greetings.random.9'),
    t('greetings.random.10'),
    t('greetings.random.11'),
    t('greetings.random.12'),
    t('greetings.random.13'),
    t('greetings.random.14'),
  ];

  // 40% chance of time-based greeting, 60% chance of random
  const useTimeBased = Math.random() < 0.4;

  if (useTimeBased) {
    if (hour >= 5 && hour < 12) {
      return morningGreetings[Math.floor(Math.random() * morningGreetings.length)];
    } else if (hour >= 12 && hour < 17) {
      return afternoonGreetings[Math.floor(Math.random() * afternoonGreetings.length)];
    } else {
      return eveningGreetings[Math.floor(Math.random() * eveningGreetings.length)];
    }
  }

  return randomGreetings[Math.floor(Math.random() * randomGreetings.length)];
}

interface DynamicGreetingProps {
  className?: string;
}

/**
 * Dynamic greeting component with letter-by-letter hover lift effect.
 * Greeting is computed once on client mount and cached at module level.
 * Uses suppressHydrationWarning to avoid SSR/client mismatch.
 */
export function DynamicGreeting({ className }: DynamicGreetingProps) {
  const t = useTranslations('dashboard');
  const [greeting, setGreeting] = useState<string | null>(cachedGreeting);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  // Generate greeting only on client mount
  useEffect(() => {
    if (!cachedGreeting) {
      cachedGreeting = generateGreeting(t);
    }
    setGreeting(cachedGreeting);
    setMounted(true);
  }, [t]);

  // Calculate lift amount based on distance from hovered letter
  const getLiftAmount = (index: number): number => {
    if (hoveredIndex === null) return 0;
    
    const distance = Math.abs(index - hoveredIndex);
    
    if (distance === 0) return -6;
    if (distance === 1) return -5;
    if (distance === 2) return -4;
    if (distance === 3) return -3;
    if (distance === 4) return -2;
    if (distance === 5) return -1.5;
    if (distance === 6) return -0.5;
    return 0;
  };

  // Show nothing during SSR, render greeting after mount
  if (!mounted || !greeting) {
    return <p className={cn('tracking-tight opacity-0', className)}>&nbsp;</p>;
  }

  return (
    <p className={cn('tracking-tight', className)}>
      {greeting.split('').map((letter, index) => (
        <span
          key={index}
          onMouseEnter={() => setHoveredIndex(index)}
          onMouseLeave={() => setHoveredIndex(null)}
          style={{
            display: 'inline-block',
            transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            transform: `translateY(${getLiftAmount(index)}px)`,
            cursor: 'default',
          }}
        >
          {letter === ' ' ? '\u00A0' : letter}
        </span>
      ))}
    </p>
  );
}
