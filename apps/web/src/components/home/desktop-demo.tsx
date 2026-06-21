'use client';

import { InteractiveDemo } from '@/components/home/interactive-demo';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

export function DesktopDemo({ className }: { className?: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div
      className={cn(
        'border-card bg-background relative aspect-video h-[min(92vh,820px)] w-full overflow-hidden rounded-[calc(var(--radius)+2px)] border-4 sm:h-[min(72vh,520px)] md:h-full',
        className,
      )}
    >
      <InteractiveDemo
        gradientbg={false}
        tab={false}
        embedded
        aside
        activePage="home"
        className="h-full w-full max-w-full"
        contentClassName={tI18nHardcoded.raw(
          'autoComponentsHomeDesktopDemoJsxAttrContentClassNameMaxWFull783e15fd',
        )}
        innerClassName={tI18nHardcoded.raw(
          'autoComponentsHomeDesktopDemoJsxAttrInnerClassNameHFullMincaf5a8f0',
        )}
        parentClassName={tI18nHardcoded.raw(
          'autoComponentsHomeDesktopDemoJsxAttrParentClassNameHFullMinb9286cc2',
        )}
      />
    </div>
  );
}
