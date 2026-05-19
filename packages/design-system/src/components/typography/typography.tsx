import * as React from 'react';
import { cn } from '../../lib/utils';

type HeadingProps = React.HTMLAttributes<HTMLHeadingElement>;
type ParagraphProps = React.HTMLAttributes<HTMLParagraphElement>;
type SpanProps = React.HTMLAttributes<HTMLSpanElement>;
type QuoteProps = React.BlockquoteHTMLAttributes<HTMLQuoteElement>;
type ListProps = React.HTMLAttributes<HTMLUListElement> & { ordered?: boolean };

export function Display({ className, ...props }: HeadingProps) {
  return (
    <h1
      className={cn(
        'font-sans text-5xl md:text-6xl lg:text-7xl tracking-tight leading-[1.05] text-balance',
        className,
      )}
      {...props}
    />
  );
}

export function H1({ className, ...props }: HeadingProps) {
  return (
    <h1
      className={cn(
        'font-sans text-4xl md:text-5xl tracking-tight leading-[1.1] text-balance',
        className,
      )}
      {...props}
    />
  );
}

export function H2({ className, ...props }: HeadingProps) {
  return (
    <h2
      className={cn(
        'font-sans font-medium text-3xl md:text-4xl tracking-[-0.015em] leading-[1.15] text-balance',
        className,
      )}
      {...props}
    />
  );
}

export function H3({ className, ...props }: HeadingProps) {
  return (
    <h3
      className={cn(
        'font-sans font-medium text-2xl tracking-[-0.01em] leading-[1.2] text-balance',
        className,
      )}
      {...props}
    />
  );
}

export function H4({ className, ...props }: HeadingProps) {
  return (
    <h4
      className={cn(
        'font-sans font-medium text-xl tracking-[-0.005em] leading-[1.25] text-balance',
        className,
      )}
      {...props}
    />
  );
}

export function Eyebrow({ className, ...props }: SpanProps) {
  return (
    <span
      className={cn(
        'font-sans text-xs uppercase tracking-[0.14em] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function P({ className, ...props }: ParagraphProps) {
  return (
    <p
      className={cn(
        'font-sans text-base leading-7 text-foreground [&:not(:first-child)]:mt-4',
        className,
      )}
      {...props}
    />
  );
}

export function Lead({ className, ...props }: ParagraphProps) {
  return (
    <p
      className={cn('font-sans text-xl leading-8 text-muted-foreground text-balance', className)}
      {...props}
    />
  );
}

export function Large({ className, ...props }: ParagraphProps) {
  return (
    <p className={cn('font-sans text-lg font-medium text-foreground', className)} {...props} />
  );
}

export function Small({ className, ...props }: ParagraphProps) {
  return (
    <p
      className={cn('font-sans text-sm font-medium leading-none text-foreground', className)}
      {...props}
    />
  );
}

export function Muted({ className, ...props }: ParagraphProps) {
  return (
    <p className={cn('font-sans text-sm leading-6 text-muted-foreground', className)} {...props} />
  );
}

export function InlineCode({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={cn(
        'font-mono rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[0.85em] text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function Blockquote({ className, ...props }: QuoteProps) {
  return (
    <blockquote
      className={cn(
        'font-sans border-l-2 border-border pl-6 italic text-foreground/90',
        className,
      )}
      {...props}
    />
  );
}

export function List({ className, ordered = false, ...props }: ListProps) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag
      className={cn(
        'font-sans my-4 ml-6 space-y-2 text-base text-foreground',
        ordered ? 'list-decimal' : 'list-disc',
        className,
      )}
      {...(props as React.HTMLAttributes<HTMLElement>)}
    />
  );
}

export const Typography = {
  Display,
  H1,
  H2,
  H3,
  H4,
  Eyebrow,
  P,
  Lead,
  Large,
  Small,
  Muted,
  InlineCode,
  Blockquote,
  List,
};
