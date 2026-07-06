import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import type { ComponentType, ReactNode } from 'react';

export type CoverLogo = { domain: string; name: string };

/**
 * A unique, on-brand cover for each post — a crisp logo lockup on the Kortix
 * gradient. Real brand marks (the official SVGs already shipped in the app) +
 * the Kortix symbol; an official favicon only as a fallback for brands we don't
 * ship an SVG for. Never an AI-drawn logo. No competitor logos → a brand mark.
 */
// Inline xAI mark (from the repo's own /provider-icons/xai.svg) so it inherits
// `currentColor` — a flat <img> of a currentColor SVG can't theme and renders
// blurry as a scaled favicon.
function GrokMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="currentColor"
    >
      <title>Grok</title>
      <path d="M12.4579 15.6036L26.1529 35H20.0656L6.37059 15.6036H12.4579ZM12.4524 26.3764L15.4974 30.6909L12.4551 35H6.36377L12.4524 26.3764ZM33.6365 7.15727V35H28.647V14.2236L33.6365 7.15727ZM33.6365 5L20.0656 24.2205L17.0206 19.9073L27.5451 5H33.6365Z" />
    </svg>
  );
}

const BRAND_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'claude cowork': Icon.Claude,
  claude: Icon.Claude,
  chatgpt: Icon.ChatGPT,
  openai: Icon.OpenAI,
  openclaw: Icon.OpenClaw,
  github: Icon.Github,
  grok: GrokMark,
};

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="border-border bg-card flex size-14 items-center justify-center overflow-hidden rounded-2xl border shadow-2xs sm:size-16">
      {children}
    </span>
  );
}

function LogoChip({ domain, name }: CoverLogo) {
  const Brand = BRAND_ICONS[name.toLowerCase()];
  return (
    <Chip>
      {Brand ? (
        <Brand className="text-foreground size-8 sm:size-9" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://www.google.com/s2/favicons?domain=${domain}&sz=128`}
          alt={name}
          width={36}
          height={36}
          loading="lazy"
          className="size-8 sm:size-9"
        />
      )}
    </Chip>
  );
}

export function BlogCover({
  logos = [],
  withKortix = true,
  className,
}: {
  logos?: CoverLogo[];
  withKortix?: boolean;
  className?: string;
}) {
  const brandOnly = logos.length === 0;
  return (
    <div
      className={cn(
        'from-muted/60 via-background to-primary/[0.08] relative flex items-center justify-center overflow-hidden bg-gradient-to-br',
        className,
      )}
    >
      <div
        className="absolute inset-0 bg-[url('/grain-texture.png')] bg-repeat opacity-[0.1]"
        aria-hidden
      />
      {brandOnly ? (
        <KortixLogo size={56} variant="logomark" className="text-foreground relative" />
      ) : (
        <div className="relative flex items-center gap-3 sm:gap-5">
          {logos.map((logo) => (
            <LogoChip key={logo.name} {...logo} />
          ))}
          {withKortix && (
            <>
              <span className="text-muted-foreground/40 text-2xl font-light">×</span>
              <Chip>
                <KortixLogo size={30} variant="symbol" className="text-foreground" />
              </Chip>
            </>
          )}
        </div>
      )}
    </div>
  );
}
