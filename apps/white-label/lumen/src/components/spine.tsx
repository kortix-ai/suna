import { cn } from '@kortix/ui';

export type SpineTone = 'navy' | 'oxblood' | 'sand' | 'slate' | 'moss';
const TONES: SpineTone[] = ['navy', 'oxblood', 'sand', 'slate', 'moss'];

/** A tone picked from a name, stable across renders. */
export function toneFor(name: string): SpineTone {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

/** A book-spine tile with a serif initial: Lumen's avatar for a workflow. */
export function Spine({ letter, tone, className }: { letter: string; tone: SpineTone; className?: string }) {
  const tones = {
    navy: 'from-[#183250] to-[#0a1828] text-[#F5F3EF]',
    oxblood: 'from-[#5a2328] to-[#3a1519] text-[#F5F3EF]',
    sand: 'from-[#E4D8C2] to-[#CDBB9A] text-[#3A3A38]',
    slate: 'from-[#7C8796] to-[#566170] text-[#F5F3EF]',
    moss: 'from-[#3E5A4C] to-[#253A30] text-[#F5F3EF]',
  } as const;
  return (
    <span aria-hidden className={cn('grid size-6 shrink-0 place-items-center rounded-[4px] bg-gradient-to-b font-display text-[13px] leading-none', tones[tone], className)}>
      {letter.slice(0, 1).toUpperCase()}
    </span>
  );
}
