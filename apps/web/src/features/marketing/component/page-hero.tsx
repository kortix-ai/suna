import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { BeamsBackdrop } from '@/components/ui/paper-wallpaper-shaders';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type Props = {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** Pills under the sub. */
  actions?: ReactNode;
  /** The page's own artifact. It overlaps the pane floor, so it renders in
   *  dark tokens: one surface across the pane edge, never half light. */
  children?: ReactNode;
  /** `band` is the short header for document pages (/support, /legal). */
  size?: 'full' | 'band';
  /** `h2` when the page body already owns the `h1`. */
  as?: 'h1' | 'h2';
};

/**
 * The one AI OS page hero: a dark Beams pane in both themes, marked
 * `data-kx-dark-hero` so the navbar sits on it transparent, with the mark, the
 * eyebrow, a centred light headline, the sub and the pills. A page's own scene
 * follows under the pane and overlaps its floor, so the first thing past the
 * headline is the artifact.
 */
export function PageHero({
  eyebrow,
  title,
  sub,
  actions,
  children,
  size = 'full',
  as: Heading = 'h1',
}: Props): ReactNode {
  const band = size === 'band';
  return (
    <>
      <section
        data-kx-dark-hero=""
        className={cn(
          'dark bg-background text-foreground relative isolate flex items-center overflow-hidden px-6',
          band ? 'pt-36 pb-16 sm:pt-44 sm:pb-20' : 'min-h-[80svh] pt-40',
          !band && (children ? 'pb-48' : 'pb-24'),
        )}
      >
        <div className="kx-hero-veil absolute inset-0 -z-10" aria-hidden>
          <BeamsBackdrop fade="hero" />
        </div>
        <div className={cn('mx-auto flex flex-col items-center gap-6 text-center', band ? 'max-w-3xl' : 'max-w-4xl')}>
          <span className="kx-hero-text text-muted-foreground flex items-center gap-2 text-lg">
            <KortixLogo size={16} />
            {eyebrow}
          </span>
          <Heading
            className={cn(
              'kx-hero-text text-foreground text-4xl font-normal tracking-tight text-balance [--kx-enter:80ms]',
              band ? 'sm:text-5xl' : 'sm:text-6xl',
            )}
          >
            {title}
          </Heading>
          {sub ? (
            <p className="kx-hero-text text-muted-foreground max-w-2xl text-lg leading-relaxed text-pretty [--kx-enter:160ms]">
              {sub}
            </p>
          ) : null}
          {actions ? (
            <div className="kx-hero-text flex flex-wrap justify-center gap-3 [--kx-enter:240ms]">
              {actions}
            </div>
          ) : null}
        </div>
      </section>
      {children ? (
        <div className="kx-hero-frame dark text-foreground relative z-10 mx-auto -mt-32 flex w-full max-w-5xl justify-center px-6 pb-12 [--kx-enter:320ms]">
          {children}
        </div>
      ) : null}
    </>
  );
}
