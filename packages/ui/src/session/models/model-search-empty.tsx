'use client';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';

export function ModelSearchEmpty({
  search,
  modelCount,
  onClear,
  onUpgrade,
}: {
  search: string;
  modelCount: number;
  onClear: () => void;
  onUpgrade?: () => void;
}) {
  const t = useTranslations('modelSelector');
  return (
    <div className="px-3 py-5 text-center">
      <div className="text-foreground text-sm font-medium">
        {t('noMatch.title')}
      </div>
      <p className="text-muted-foreground mt-1 text-xs leading-5">
        {modelCount === 1
          ? t('noMatch.singleModelDescription')
          : t('noMatch.description', { search: search.trim() })}
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button type="button" size="xs" variant="outline" onClick={onClear}>
          {t('noMatch.clear')}
        </Button>
        {modelCount === 1 && onUpgrade && (
          <Button type="button" size="xs" onClick={onUpgrade}>
            {t('upgrade')}
          </Button>
        )}
      </div>
    </div>
  );
}
