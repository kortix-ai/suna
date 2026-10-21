import { cn } from '@kortix/ui';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import type { FirmStyle } from './content';

/**
 * The public site's building blocks. One grid (1280 px content, 80 px gutter
 * on desktop, 24 px on a phone), one radius family (4 px rectangles, pills for
 * every action), full-bleed hairlines between sections.
 */

export function Container({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-[1440px] px-6 md:px-12 xl:px-20', className)}>{children}</div>;
}

/** A band: generous vertical rhythm, a full-bleed hairline above it. */
export function Section({
  className,
  children,
  rule = true,
  id,
}: {
  className?: string;
  children: React.ReactNode;
  rule?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={cn('py-24 md:py-36', rule && 'border-t border-hairline', className)}>
      {children}
    </section>
  );
}

export function Eyebrow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn('text-[15px] font-medium tracking-[-0.01em] text-foreground', className)}>{children}</p>;
}

/** Body copy is grey, never black. */
export function Lead({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn('text-lg leading-[1.35] tracking-[-0.015em] text-muted-foreground md:text-xl', className)}>{children}</p>;
}

/** A text CTA with the arrow in a small tinted circle: "Learn more →". */
export function ArrowLink({
  href,
  children,
  tone = 'ink',
  className,
}: {
  href: string;
  children: React.ReactNode;
  tone?: 'ink' | 'light' | 'muted';
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group inline-flex items-center gap-2.5 text-[15px] font-medium tracking-[-0.01em] transition-colors',
        tone === 'ink' && 'text-foreground',
        tone === 'muted' && 'text-muted-foreground hover:text-foreground',
        tone === 'light' && 'text-white',
        className,
      )}
    >
      {children}
      <span
        className={cn(
          'grid size-6 place-items-center rounded-full transition-transform duration-200 group-hover:translate-x-0.5',
          tone === 'light' ? 'bg-white/14' : 'bg-foreground/[0.06]',
        )}
      >
        <ArrowRightIcon className="size-3.5" weight="bold" />
      </span>
    </Link>
  );
}

/** The pill CTA. `solid` is the brand surface; `light` is white on the brand surface; `glass` is the translucent hero pill. */
export function PillLink({
  href,
  children,
  variant = 'solid',
  arrow = false,
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: 'solid' | 'light' | 'glass' | 'outline';
  arrow?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group inline-flex h-10 items-center gap-2.5 rounded-full px-5 text-[15px] font-medium tracking-[-0.01em] transition-colors duration-200',
        variant === 'solid' && 'bg-navy text-white hover:bg-navy-700 dark:bg-[#F5F3EF] dark:text-navy dark:hover:bg-white',
        variant === 'light' && 'bg-white text-navy hover:bg-[#F5F3EF]',
        variant === 'glass' && 'bg-white/10 text-white backdrop-blur hover:bg-white/16',
        variant === 'outline' && 'border border-border text-foreground hover:bg-foreground/[0.04]',
        arrow && 'pr-2',
        className,
      )}
    >
      {children}
      {arrow && (
        <span className={cn('grid size-6 place-items-center rounded-full', variant === 'glass' ? 'bg-white/14' : 'bg-current/10')}>
          <ArrowRightIcon className="size-3.5" weight="bold" />
        </span>
      )}
    </Link>
  );
}

/** A paper media card: one cropped product moment, centred, with a soft floor. */
export function MediaCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'relative isolate flex w-full items-center justify-center overflow-hidden rounded-[4px] bg-paper px-5 py-10 md:aspect-[628/560] md:p-12',
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-paper-deep/80 to-transparent" />
      <div className="relative w-full max-w-[460px]">{children}</div>
    </div>
  );
}

/** The brand surface with the laid-paper weave: the frame behind product UI. */
export function BrandFrame({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <div className={cn('pattern-laid relative isolate overflow-hidden rounded-[4px]', className)}>{children}</div>;
}

/** A centred section title in the display serif. */
export function SectionTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h2 className={cn('display-md mx-auto max-w-4xl text-center text-balance', className)}>{children}</h2>;
}

/** A fictional firm drawn as a type-only lockup. */
export function FirmLockup({ name, style, className }: { name: string; style: FirmStyle; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap leading-none',
        style === 'serif' && 'font-display text-[22px] tracking-[-0.02em]',
        style === 'serif-italic' && 'font-display text-[22px] tracking-[-0.02em] italic',
        style === 'caps' && 'font-display text-[16px] tracking-[0.14em]',
        style === 'sans' && 'text-[19px] font-medium tracking-[-0.03em]',
        style === 'sans-bold' && 'text-[18px] font-semibold tracking-[-0.04em]',
        style === 'wide' && 'text-[14px] font-medium tracking-[0.32em]',
        className,
      )}
    >
      {name}
    </span>
  );
}

/** The abstract "photograph" behind a story card: a dim, motion-smeared interior, drawn in CSS. */
export function Photo({ tone, className, children }: { tone: 'stone' | 'night' | 'ember' | 'moss'; className?: string; children?: React.ReactNode }) {
  const tones = {
    night: 'radial-gradient(60% 80% at 70% 30%, rgb(120 146 178 / 0.55), transparent 70%), radial-gradient(40% 60% at 20% 80%, rgb(200 155 74 / 0.25), transparent 70%), linear-gradient(115deg, #0a1828, #183250 55%, #0a1828)',
    stone: 'radial-gradient(70% 70% at 30% 30%, rgb(236 233 227 / 0.35), transparent 70%), radial-gradient(50% 60% at 80% 70%, rgb(16 35 58 / 0.6), transparent 70%), linear-gradient(100deg, #3a3a38, #6b6964 50%, #2a2a28)',
    ember: 'radial-gradient(55% 75% at 75% 35%, rgb(200 155 74 / 0.5), transparent 70%), radial-gradient(60% 60% at 15% 70%, rgb(180 68 47 / 0.25), transparent 70%), linear-gradient(110deg, #1a120c, #3a2618 55%, #120d09)',
    moss: 'radial-gradient(60% 80% at 30% 40%, rgb(108 192 154 / 0.25), transparent 70%), radial-gradient(50% 60% at 85% 75%, rgb(16 35 58 / 0.6), transparent 70%), linear-gradient(120deg, #0e1a16, #24372f 50%, #0b1411)',
  } as const;
  return (
    <div className={cn('relative isolate overflow-hidden rounded-[4px]', className)} style={{ backgroundImage: tones[tone] }}>
      {/* Vertical streaks: a slow shutter past window mullions. */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-40 mix-blend-overlay"
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, rgb(255 255 255 / 0.18) 0 2px, transparent 2px 38px, rgb(0 0 0 / 0.25) 38px 46px, transparent 46px 90px)',
          filter: 'blur(6px)',
        }}
      />
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(100%_100%_at_50%_50%,transparent_40%,rgb(0_0_0/0.45))]" />
      {children}
    </div>
  );
}

/** "◆ Needs review": status text with a diamond bullet. */
export function Diamond({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block size-[7px] rotate-45 rounded-[1px] bg-current', className)} />;
}
