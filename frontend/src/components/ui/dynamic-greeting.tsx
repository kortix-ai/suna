'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// Generate stable random indices on module load (persists until page refresh)
const greetingTypeRandom = Math.random(); // 0-1, determines time-based vs random
const greetingIndexRandom = Math.random(); // 0-1, determines which greeting in array

interface DynamicGreetingProps {
  className?: string;
}

/**
 * Dynamic greeting with letter-by-letter hover effect.
 * Uses stable random indices so greeting type stays consistent,
 * but text updates immediately when language changes.
 */
export function DynamicGreeting({ className }: DynamicGreetingProps) {
  const t = useTranslations('dashboard');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Compute greeting - recalculates when t changes (i.e., when language changes)
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    
    // 40% chance time-based, 60% random
    const useTimeBased = greetingTypeRandom < 0.4;

    if (useTimeBased) {
      if (hour >= 5 && hour < 12) {
        const greetings = [
          t('greetings.morning.0'),
          t('greetings.morning.1'),
          t('greetings.morning.2'),
        ];
        return greetings[Math.floor(greetingIndexRandom * greetings.length)];
      } else if (hour >= 12 && hour < 17) {
        const greetings = [
          t('greetings.afternoon.0'),
          t('greetings.afternoon.1'),
        ];
        return greetings[Math.floor(greetingIndexRandom * greetings.length)];
      } else {
        const greetings = [
          t('greetings.evening.0'),
          t('greetings.evening.1'),
          t('greetings.evening.2'),
        ];
        return greetings[Math.floor(greetingIndexRandom * greetings.length)];
      }
    }

    const greetings = [
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
    return greetings[Math.floor(greetingIndexRandom * greetings.length)];
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

  // Show placeholder during SSR
  if (!mounted) {
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
