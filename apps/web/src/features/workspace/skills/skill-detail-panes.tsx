'use client';

/**
 * The two panes of the skill detail modal — ux-references/perplexity/09.
 *
 * Left: About (collapsible) + Files. Right: the file, frontmatter first, then
 * whatever the caller renders as the body. Kept free of data fetching and
 * markdown rendering so the layout contract is assertable without a DOM.
 */

import { ChevronDown, FileText } from 'lucide-react';
import type { ReactNode } from 'react';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';

import { SKILL_KINDS, type SkillEntity, type SkillKind, skillFileName } from './skill-entities';

export interface SkillDetailPanesProps {
  kind: SkillKind;
  entity: SkillEntity;
  /** Raw frontmatter block, shown verbatim above the body like the reference. */
  frontmatter: string;
  /** Rendered markdown, a skeleton, or an error banner — the caller decides. */
  body: ReactNode;
}

export function SkillDetailPanes({ kind, entity, frontmatter, body }: SkillDetailPanesProps) {
  const meta = SKILL_KINDS[kind];

  return (
    // Below lg the whole body is the scroller; at lg the two panes scroll
    // independently and this must not scroll as well.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <aside className="border-border/60 shrink-0 border-b lg:h-full lg:min-h-0 lg:w-64 lg:overflow-y-auto lg:border-r lg:border-b-0">
        <Disclosure open className="group border-border/60 border-b">
          <DisclosureTrigger>
            <div className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 px-4 py-3 text-xs font-medium select-none">
              <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
              About
            </div>
          </DisclosureTrigger>
          <DisclosureContent>
            <p className="text-foreground/80 px-4 pb-4 text-sm leading-relaxed text-pretty">
              {entity.description ?? `This ${meta.noun} has no description yet.`}
            </p>
          </DisclosureContent>
        </Disclosure>

        <div className="px-4 py-3">
          <p className="text-muted-foreground text-xs font-medium">Files</p>
          <ul className="mt-2 space-y-0.5">
            <li>
              <div
                title={entity.path}
                className="bg-muted/60 text-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm"
              >
                <FileText className="text-muted-foreground size-3.5 shrink-0" />
                <span className="truncate">{skillFileName(entity.path)}</span>
              </div>
            </li>
          </ul>
          <p className="text-muted-foreground/60 mt-2 truncate font-mono text-[11px]">
            {entity.path}
          </p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 lg:h-full lg:min-h-0 lg:overflow-y-auto">
        <div className="px-6 py-5">
          {frontmatter.trim() ? (
            <pre className="text-foreground/80 border-border/60 mb-6 border-b pb-5 font-sans text-sm leading-relaxed whitespace-pre-wrap">
              {frontmatter.trim()}
            </pre>
          ) : null}
          {body}
        </div>
      </div>
    </div>
  );
}

export default SkillDetailPanes;
