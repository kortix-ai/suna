'use client';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { MEMORY_GROUPS, MEMORY_TYPE_ICON } from './memory-labels';

const TRY = ['one', 'two', 'three'] as const;

/**
 * A layer with no pages yet: what memory is, one example per type, and three
 * sentences that fill the Remember bar. `onTry` is absent when the viewer
 * cannot write (an archived channel): the examples stay, the chips go.
 */
export function MemoryEmpty({
  kind,
  place,
  onTry,
}: {
  kind: 'channel' | 'dm';
  place: string;
  onTry?: (text: string) => void;
}) {
  const t = useTranslations('spaces.memory');
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-7 overflow-y-auto px-6 py-10 @2xl/memory:px-16">
      <div className="flex max-w-xl flex-col gap-2.5">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {t(kind === 'dm' ? 'empty.titleDm' : 'empty.title', { place })}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed text-pretty">
          {t(kind === 'dm' ? 'empty.descriptionDm' : 'empty.description', { place })}
        </p>
      </div>
      <ul className="flex max-w-xl flex-col border-t">
        {MEMORY_GROUPS.filter((type) => type !== 'note').map((type) => {
          const Glyph = MEMORY_TYPE_ICON[type];
          return (
            <li key={type} className="flex min-h-12 items-center gap-3 border-b py-2">
              <span className="flex w-4 shrink-0 justify-center">
                <Glyph aria-hidden className="text-muted-foreground size-3.5" />
              </span>
              <span className="w-30 shrink-0 text-xs font-medium">{t(`type.${type}`)}</span>
              <span className="text-muted-foreground min-w-0 text-xs">{t(`empty.example.${type}`)}</span>
            </li>
          );
        })}
      </ul>
      {onTry ? (
        <div className="flex max-w-xl flex-col gap-2.5">
          <p className="text-muted-foreground text-xs">{t('empty.tryOne')}</p>
          <div className="flex flex-wrap gap-2">
            {TRY.map((key) => (
              <Button key={key} variant="outline" size="toolbar" onClick={() => onTry(t(`empty.try.${key}`))}>
                {t(`empty.try.${key}`)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
