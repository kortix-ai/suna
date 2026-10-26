import { cn } from '@kortix/ui';

/**
 * Prose for a compiled MDX body (the use-case pages). An MDX body is a server
 * component, so it cannot run through `UnifiedMarkdown`; this wrapper gives
 * its plain elements the same classes `UnifiedMarkdown` gives the same
 * elements (`components/markdown/unified-markdown.tsx`, `MARKDOWN_COMPONENTS`):
 * the 15px root, ink paragraphs and list items, the heading ladder, blue
 * links, chip code, the quote rule and the framed table. Change the two
 * together.
 */
const prose = cn(
  // Root: the UnifiedMarkdown root size. audit: the renderer's own 15px.
  'kortix-markdown text-[15px] text-foreground [overflow-wrap:anywhere]',
  // Headings. `scroll-mt-24` keeps a contents link clear of the fixed bar.
  '[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:scroll-mt-24',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:scroll-mt-24',
  '[&_h4]:mt-6 [&_h4]:mb-2 [&_h4]:text-lg [&_h4]:font-semibold [&_h4]:text-foreground',
  // Body
  '[&_p]:my-4 [&_p]:leading-relaxed [&_p]:font-medium',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_a]:font-medium [&_a]:text-kortix-blue [&_a]:underline [&_a]:decoration-kortix-blue/40 [&_a]:underline-offset-[3px] [&_a]:transition-colors hover:[&_a]:decoration-kortix-blue',
  // Lists
  '[&_ul]:my-4 [&_ul]:list-outside [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6 [&_ul]:marker:text-muted-foreground',
  '[&_ol]:my-4 [&_ol]:list-outside [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6 [&_ol]:marker:text-muted-foreground [&_ol]:marker:font-medium [&_ol]:marker:tabular-nums',
  '[&_li]:leading-relaxed [&_li]:font-medium [&_li_p]:mb-2',
  // Code: the inline chip and the bordered block.
  '[&_code]:rounded-sm [&_code]:border [&_code]:border-border [&_code]:bg-card [&_code]:px-1.5 [&_code]:font-mono [&_code]:text-sm [&_code]:font-medium',
  '[&_pre]:my-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-popover [&_pre]:px-4 [&_pre]:py-2.5 [&_pre]:text-xs [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  // Quotes, rules, media
  '[&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-6 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
  '[&_hr]:my-6 [&_hr]:border-border',
  '[&_img]:my-5 [&_img]:rounded-md [&_img]:border [&_img]:border-border',
  // Tables
  '[&_table]:my-5 [&_table]:w-full [&_table]:text-sm',
  '[&_thead]:border-b [&_thead]:border-border [&_thead]:bg-muted',
  '[&_th]:px-4 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:whitespace-nowrap',
  '[&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-2 [&_td]:align-top',
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
