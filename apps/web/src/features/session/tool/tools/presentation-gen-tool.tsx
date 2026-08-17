'use client';
import { STATUS_TEXT } from '@/components/ui/status';
import {
  BasicTool,
  InlineServicePreview,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import {
  CheckIcon as Check,
  ArrowSquareOutIcon as ExternalLink,
  PresentationIcon as Presentation,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useContext, useMemo } from 'react';

import { parsePresentationOutput } from '@/features/session/tool/shared/presentation-helpers';

const ACTION_LABELS: Record<string, string> = {
  create_slide: 'Create Slide',
  list_slides: 'List Slides',
  delete_slide: 'Delete Slide',
  list_presentations: 'List',
  delete_presentation: 'Delete',
  validate_slide: 'Validate',
  export_pdf: 'Export PDF',
  export_pptx: 'Export PPTX',
  preview: 'Preview',
  serve: 'Serve',
};

// The actions that draw their own success line below; everything else falls
// through to the generic one. Module-level so the render path stops rebuilding
// the array on every frame.
const ACTIONS_WITH_OWN_SUCCESS_LINE = [
  'create_slide',
  'validate_slide',
  'preview',
  'serve',
  'export_pdf',
  'export_pptx',
];

export function PresentationGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const action = input.action as string | undefined;
  const presentationName = input.presentation_name as string | undefined;
  const slideTitle = input.slide_title as string | undefined;
  const slideNumber = input.slide_number as number | string | undefined;

  const parsed = useMemo(() => parsePresentationOutput(output), [output]);
  const isError = parsed ? !parsed.success : false;

  const { proxyUrl } = useSandboxProxy();
  const viewerProxyUrl = useMemo(() => {
    if (!parsed?.viewer_url) return undefined;
    return proxyUrl(parsed.viewer_url);
  }, [parsed?.viewer_url, proxyUrl]);

  const triggerSubtitle = useMemo(() => {
    if (action === 'create_slide' && slideTitle) {
      return `Slide ${slideNumber || '?'}: ${slideTitle}`;
    }
    if (action === 'preview' || action === 'serve') return presentationName;
    if (action === 'export_pdf') return `${presentationName} → PDF`;
    if (action === 'export_pptx') return `${presentationName} → PPTX`;
    if (action === 'list_slides') return presentationName;
    if (action === 'list_presentations') return 'All presentations';
    if (action === 'delete_slide' || action === 'delete_presentation') return presentationName;
    if (action === 'validate_slide') return `Slide ${slideNumber || '?'}`;
    return presentationName || action;
  }, [action, presentationName, slideTitle, slideNumber]);

  const actionLabel = ACTION_LABELS[action ?? ''] || action;

  return (
    <BasicTool
      icon={<Presentation className="size-3.5 shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {actionLabel ? (
            <span className="text-foreground text-xs font-medium whitespace-nowrap">
              {actionLabel}
            </span>
          ) : running ? (
            <span className="bg-muted-foreground/10 h-3 w-20 animate-pulse rounded" />
          ) : null}
          {triggerSubtitle ? (
            <span className="text-muted-foreground truncate font-mono text-xs">
              {triggerSubtitle}
            </span>
          ) : running && actionLabel ? (
            <span className="bg-muted-foreground/10 h-3 w-32 animate-pulse rounded" />
          ) : null}
          {parsed?.success && action === 'create_slide' && parsed.total_slides && (
            <span className="text-muted-foreground/60 ml-auto shrink-0 font-mono text-xs whitespace-nowrap">
              {parsed.total_slides} {parsed.total_slides === 1 ? 'slide' : 'slides'}
            </span>
          )}
          {viewerProxyUrl && (
            <a
              href={safeHttpUrl(viewerProxyUrl) ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="text-muted-foreground/60 hover:text-foreground size-3 transition-colors" />
            </a>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError && <ToolOutputFallback output={output} toolName="presentation" />}

      {parsed?.success && (
        <div className="space-y-1.5 px-3 py-2.5">
          {action === 'create_slide' && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                {tHardcodedUi.raw('componentsSessionToolRenderers.line4612JsxTextCreatedSlide')}{' '}
                {parsed.slide_number}
                {parsed.slide_title ? `: ${parsed.slide_title}` : ''}
              </span>
              {parsed.total_slides && (
                <span className="text-muted-foreground/50 ml-auto text-xs">
                  ({parsed.total_slides} total)
                </span>
              )}
            </div>
          )}

          {action === 'validate_slide' && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                Slide {parsed.slide_number || slideNumber || '?'} validated
              </span>
              {parsed.message && parsed.message !== `Slide ${parsed.slide_number} validated` && (
                <span className="text-muted-foreground/60 truncate">{parsed.message}</span>
              )}
            </div>
          )}

          {(action === 'preview' || action === 'serve') && parsed.viewer_url && (
            <InlineServicePreview
              url={parsed.viewer_url}
              label={`Presentation: ${parsed.presentation_name || presentationName || 'Viewer'}`}
            />
          )}

          {(action === 'export_pdf' || action === 'export_pptx') && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                Exported {parsed.presentation_name || presentationName} to{' '}
                {action === 'export_pdf' ? 'PDF' : 'PPTX'}
              </span>
            </div>
          )}

          {!ACTIONS_WITH_OWN_SUCCESS_LINE.includes(action as string) && (
            <div className="flex items-center gap-2 text-xs">
              <Check className={cn('size-3 shrink-0', STATUS_TEXT.success)} />
              <span className="text-foreground/80">
                {parsed.message || `${actionLabel} completed`}
              </span>
            </div>
          )}

          {parsed.slide_file && action !== 'preview' && action !== 'serve' && (
            <div className="text-muted-foreground/50 truncate font-mono text-xs">
              {parsed.slide_file}
            </div>
          )}
        </div>
      )}

      {!parsed && output && (
        <div data-scrollable className="max-h-96 overflow-auto p-2">
          <pre className="text-muted-foreground/60 font-mono text-xs whitespace-pre-wrap">
            {output}
          </pre>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('presentation-gen', PresentationGenTool);
