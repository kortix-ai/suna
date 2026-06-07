import { cn } from '@/lib/utils';

/**
 * Editorial prose for rendered blog MDX. Token-driven (no hardcoded colors),
 * tuned for long-form reading rather than the dense docs chrome. Wrap the MDX
 * body in this and the markdown styles itself.
 */
const prose = cn(
  'text-base leading-[1.75] text-muted-foreground',
  // Headings
  '[&_h2]:mt-12 [&_h2]:mb-4 [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:tracking-tight [&_h2]:text-foreground [&_h2]:scroll-mt-24',
  '[&_h3]:mt-9 [&_h3]:mb-3 [&_h3]:text-lg [&_h3]:font-medium [&_h3]:tracking-tight [&_h3]:text-foreground [&_h3]:scroll-mt-24',
  '[&_h4]:mt-7 [&_h4]:mb-2 [&_h4]:text-base [&_h4]:font-semibold [&_h4]:text-foreground',
  // Body
  '[&_p]:my-5',
  '[&_strong]:font-medium [&_strong]:text-foreground',
  '[&_a]:text-foreground [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-foreground/25 hover:[&_a]:decoration-foreground/60 [&_a]:transition-colors',
  // Lists
  '[&_ul]:my-5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-2',
  '[&_ol]:my-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-2',
  '[&_li]:pl-1.5 [&_li]:marker:text-muted-foreground/40',
  '[&_li>ul]:my-2 [&_li>ol]:my-2',
  // Code
  '[&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_code]:text-foreground',
  '[&_pre]:my-6 [&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:border [&_pre]:border-border/60 [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-sm [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[0.95em]',
  // Quotes, rules, media
  '[&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-5 [&_blockquote]:text-foreground/90 [&_blockquote]:italic',
  '[&_hr]:my-10 [&_hr]:border-border/60',
  '[&_img]:my-7 [&_img]:rounded-2xl [&_img]:border [&_img]:border-border/60',
  // Tables
  '[&_table]:my-6 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-foreground',
  '[&_td]:border-b [&_td]:border-border/50 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
);

export function BlogProse({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn(prose, className)}>{children}</div>;
}
