import type { ReactNode } from 'react';

import { Band } from './page-frame';

/** `**phrase**` in a paragraph renders the phrase in ink; the rest stays muted. */
function Emphasis({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith('**') ? (
          <span key={i} className="text-foreground">
            {part.slice(2, -2)}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * One section of a long marketing page, condensed: the two-tone title on the
 * left, one or two short paragraphs on the right with the phrases that matter
 * in ink, then optionally a visual, then the facts as one-line cells in a
 * band. Cells are `k` (a short noun phrase) and `v` (one sentence).
 */
export function FeatureSplit({
  id,
  title,
  titleMuted,
  body,
  visual,
  cells,
  cols = 'lg:grid-cols-4',
  layout = 'stacked',
  after,
}: {
  id: string;
  title: string;
  titleMuted: string;
  body: readonly string[];
  visual?: ReactNode;
  cells?: readonly { k: string; v: string }[];
  cols?: string;
  /** `stacked`: visual, then a row of cells. `split`: the cells one under
   *  another on the left, the visual on the right. */
  layout?: 'stacked' | 'split';
  /** Anything that belongs to the section under its band, e.g. a second band. */
  after?: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 py-20 lg:py-28">
      <div className="grid grid-cols-1 gap-8 px-8 lg:grid-cols-2 lg:gap-16 lg:px-28">
        <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
          {title}
          <span className="text-muted-foreground block">{titleMuted}</span>
        </h2>
        <div className="flex flex-col gap-5">
          {body.map((paragraph) => (
            <p key={paragraph} className="text-muted-foreground text-base text-pretty lg:text-lg">
              <Emphasis text={paragraph} />
            </p>
          ))}
        </div>
      </div>

      {layout === 'split' && visual && cells?.length ? (
        <Band className="mt-12">
          <div className="grid grid-cols-1 lg:grid-cols-2">
            <ul className="divide-y">
              {cells.map((cell) => (
                <li key={cell.k} className="flex flex-col gap-2 px-6 py-6 lg:px-11 lg:py-8">
                  <h3 className="text-foreground text-base font-medium text-pretty">{cell.k}</h3>
                  <p className="text-muted-foreground text-sm text-pretty">{cell.v}</p>
                </li>
              ))}
            </ul>
            <div className="flex flex-col border-t lg:border-t-0 lg:border-l">{visual}</div>
          </div>
        </Band>
      ) : visual || cells?.length ? (
        <Band className="mt-12">
          {visual}
          {cells?.length ? (
            <ul className={`bg-border grid grid-cols-1 gap-px sm:grid-cols-2 ${visual ? 'border-t' : ''} ${cols}`}>
              {cells.map((cell) => (
                <li key={cell.k} className="bg-background flex flex-col gap-2 p-6 lg:p-8">
                  <h3 className="text-foreground text-base font-medium text-pretty">{cell.k}</h3>
                  <p className="text-muted-foreground text-sm text-pretty">{cell.v}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </Band>
      ) : null}
      {after}
    </section>
  );
}
