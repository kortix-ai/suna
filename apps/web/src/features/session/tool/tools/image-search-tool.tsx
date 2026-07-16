'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { safeHttpUrl } from '@/lib/safe-url';
import {
  Image as ImageIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useMemo,
} from 'react';


export function ImageSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  const { imageResults, isBatch, batchCount, displayQuery } = useMemo(() => {
    if (!output)
      return {
        imageResults: [],
        isBatch: false,
        batchCount: 0,
        displayQuery: query,
      };
    try {
      const parsed = JSON.parse(output);

      if (parsed.batch_mode === true && Array.isArray(parsed.results)) {
        const allImages = parsed.results.flatMap((r: any) =>
          Array.isArray(r.images) ? r.images : [],
        );
        const queries = parsed.results.map((r: any) => r.query).filter(Boolean);
        return {
          imageResults: allImages,
          isBatch: true,
          batchCount: parsed.results.length,
          displayQuery: queries.length > 1 ? `${queries.length} queries` : queries[0] || query,
        };
      }

      if (parsed.batch_results && Array.isArray(parsed.batch_results)) {
        const allImages = parsed.batch_results.flatMap((r: any) =>
          Array.isArray(r.images) ? r.images : [],
        );
        return {
          imageResults: allImages,
          isBatch: true,
          batchCount: parsed.batch_results.length,
          displayQuery: query,
        };
      }

      if (Array.isArray(parsed))
        return {
          imageResults: parsed,
          isBatch: false,
          batchCount: 0,
          displayQuery: query,
        };
      if (parsed.images && Array.isArray(parsed.images))
        return {
          imageResults: parsed.images,
          isBatch: false,
          batchCount: 0,
          displayQuery: query,
        };
      if (parsed.results && Array.isArray(parsed.results))
        return {
          imageResults: parsed.results,
          isBatch: false,
          batchCount: 0,
          displayQuery: query,
        };
    } catch {}
    return {
      imageResults: [],
      isBatch: false,
      batchCount: 0,
      displayQuery: query,
    };
  }, [output, query]);

  return (
    <BasicTool
      icon={<ImageIcon className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line4240JsxTextImageSearch')}
          </span>
          <span className="text-muted-foreground truncate font-mono text-xs">{displayQuery}</span>
          {imageResults.length > 0 && (
            <span className="text-muted-foreground/60 ml-auto flex-shrink-0 font-mono text-xs whitespace-nowrap">
              {isBatch ? `${batchCount}q, ` : ''}
              {imageResults.length} images
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {status === 'completed' && isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="image_search" />
      ) : imageResults.length > 0 ? (
        <div data-scrollable className="scrollbar-hide max-h-80 overflow-auto p-2">
          <div className="grid grid-cols-3 gap-1.5">
            {imageResults.slice(0, 9).map((img: any, i: number) => {
              const imgUrl = safeHttpUrl(img.url || img.imageUrl || img.image_url || '');
              if (!imgUrl) return null;
              const title = img.title || '';
              return (
                <a
                  key={i}
                  href={imgUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative aspect-square overflow-hidden"
                  title={title}
                >
                  <img
                    src={imgUrl}
                    alt={title}
                    className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <div className="absolute inset-x-0 bottom-0 flex items-end bg-black/60 p-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="truncate text-xs text-white">{title}</span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      ) : output ? (
        <ToolOutputFallback
          output={output.slice(0, 3000)}
          isStreaming={status === 'running'}
          toolName="image_search"
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('image-search', ImageSearchTool);

