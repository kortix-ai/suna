'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useAuth } from '@/features/providers/auth-provider';
import { useDownloadRestriction } from '@/hooks/billing';
import { toast } from '@/lib/toast';
import { Download, FileText, Presentation } from 'lucide-react';
import { useMemo, useState } from 'react';
import { LoadingState } from '../shared/LoadingState';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { DownloadFormat, downloadPresentation } from '../utils/presentation-utils';

interface ExportToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

type ExportFormat = 'pptx' | 'pdf';

export function ExportToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
  project,
}: ExportToolViewProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { session } = useAuth();
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'exports',
  });

  const [downloadingFormat, setDownloadingFormat] = useState<ExportFormat | null>(null);

  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'export-presentation';
  const isUnifiedExport = name === 'export-presentation' || name === 'export_presentation';

  const { presentationName, exports, totalSlides } = useMemo(() => {
    console.log('[ExportToolView] Parsing:', { toolResult, name, isUnifiedExport });

    if (toolResult?.output) {
      try {
        const output = toolResult.output;
        const parsed = typeof output === 'string' ? JSON.parse(output) : output;
        console.log('[ExportToolView] Parsed output:', parsed);

        if (isUnifiedExport && parsed.exports) {
          return {
            presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
            exports: parsed.exports as Record<
              ExportFormat,
              { file?: string; download_url?: string; stored_locally?: boolean }
            >,
            totalSlides: parsed.total_slides,
          };
        }

        const format: ExportFormat = name.includes('pdf') ? 'pdf' : 'pptx';
        return {
          presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
          exports: {
            [format]: {
              file: parsed.pptx_file || parsed.pdf_file,
              download_url: parsed.download_url,
              stored_locally: parsed.stored_locally,
            },
          } as Record<
            ExportFormat,
            { file?: string; download_url?: string; stored_locally?: boolean }
          >,
          totalSlides: parsed.total_slides,
        };
      } catch (e) {
        console.error('[ExportToolView] Parse error:', e);
        return { presentationName: toolCall?.arguments?.presentation_name };
      }
    }
    return { presentationName: toolCall?.arguments?.presentation_name };
  }, [toolResult, name, isUnifiedExport, toolCall?.arguments]);

  const hasPptx = !!exports?.pptx;
  const hasPdf = !!exports?.pdf;

  console.log('[ExportToolView] Exports:', { exports, hasPptx, hasPdf });

  if (!toolCall) return null;

  const handleDownload = async (format: ExportFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }

    const exportData = exports?.[format];

    // Try direct download first if we have download_url
    if (exportData?.download_url) {
      try {
        setDownloadingFormat(format);

        const ext = format === 'pdf' ? '.pdf' : '.pptx';
        const rawFilename = exportData.download_url.split('/').pop() || `presentation${ext}`;
        const filename = rawFilename.trim().replace(/[\r\n]+/g, '') || `presentation${ext}`;

        const { downloadFile } = await import('@/features/files/api/opencode-files');
        await downloadFile(exportData.download_url, filename);

        toast.success(`Downloaded ${filename}`);
        return;
      } catch (error) {
        console.error('Direct download failed, trying conversion:', error);
      } finally {
        setDownloadingFormat(null);
      }
    }

    // Fallback to conversion endpoint
    if (!project?.sandbox?.sandbox_url || !presentationName) {
      toast.error('Unable to download - missing sandbox or presentation info');
      return;
    }

    setDownloadingFormat(format);
    try {
      const downloadFormat = format === 'pdf' ? DownloadFormat.PDF : DownloadFormat.PPTX;
      await downloadPresentation(
        downloadFormat,
        project.sandbox.sandbox_url,
        `/workspace/presentations/${presentationName}`,
        presentationName,
      );
      toast.success(`Downloaded ${format.toUpperCase()}`);
    } catch (error) {
      console.error(`Download error:`, error);
      toast.error(
        `Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      setDownloadingFormat(null);
    }
  };

  // Loading state
  if (isStreaming) {
    return (
      <Card className="bg-card flex h-full flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none">
        <CardHeader className="h-14 flex-shrink-0 border-b bg-zinc-50/80 p-2 px-4 dark:bg-zinc-900/80">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle
              icon={Download}
              title={tHardcodedUi.raw(
                'componentsThreadToolViewsPresentationToolsExporttoolview.line144JsxAttrTitleExportPresentation',
              )}
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 p-0">
          <LoadingState
            icon={Download}
            iconColor="text-zinc-500"
            bgColor={tHardcodedUi.raw(
              'componentsThreadToolViewsPresentationToolsExporttoolview.line151JsxAttrBgcolorBgZinc50DarkBgZinc900',
            )}
            title="Exporting"
            filePath={presentationName || 'presentation'}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card flex h-full flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none">
      {/* Header */}
      <CardHeader className="h-14 flex-shrink-0 border-b bg-zinc-50/80 p-2 px-4 dark:bg-zinc-900/80">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Download}
            title={presentationName ? `Export: ${presentationName}` : 'Export Presentation'}
          />
          {totalSlides && (
            <span className="text-muted-foreground text-xs">{totalSlides} slides</span>
          )}
        </div>
      </CardHeader>

      {/* Download Buttons */}
      <CardContent className="flex-1 p-4">
        <div className="flex gap-3">
          {/* PDF Button */}
          <Button
            onClick={() => handleDownload('pdf')}
            disabled={!!downloadingFormat || !hasPdf}
            className="h-12 flex-1 bg-black font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {downloadingFormat === 'pdf' ? (
              <KortixLoader customSize={16} variant="white" className="mr-2 dark:hidden" />
            ) : (
              <FileText className="mr-2 h-4 w-4" />
            )}
            {downloadingFormat === 'pdf' ? (
              <KortixLoader customSize={16} variant="black" className="mr-2 hidden dark:flex" />
            ) : null}
            {tHardcodedUi.raw(
              'componentsThreadToolViewsPresentationToolsExporttoolview.line192JsxTextDownloadPdf',
            )}
          </Button>

          {/* PPTX Button */}
          <Button
            onClick={() => handleDownload('pptx')}
            disabled={!!downloadingFormat || !hasPptx}
            className="h-12 flex-1 bg-black font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {downloadingFormat === 'pptx' ? (
              <KortixLoader customSize={16} variant="white" className="mr-2 dark:hidden" />
            ) : (
              <Presentation className="mr-2 h-4 w-4" />
            )}
            {downloadingFormat === 'pptx' ? (
              <KortixLoader customSize={16} variant="black" className="mr-2 hidden dark:flex" />
            ) : null}
            {tHardcodedUi.raw(
              'componentsThreadToolViewsPresentationToolsExporttoolview.line209JsxTextDownloadPptx',
            )}
          </Button>
        </div>

        {/* Show message if no exports available */}
        {!hasPdf && !hasPptx && (
          <p className="text-muted-foreground mt-3 text-center text-sm">
            {tHardcodedUi.raw(
              'componentsThreadToolViewsPresentationToolsExporttoolview.line216JsxTextNoExportFilesAvailableYet',
            )}
          </p>
        )}
      </CardContent>

      {/* Footer - pushed to bottom */}
      <div className="mt-auto flex h-10 flex-shrink-0 items-center justify-end border-t bg-zinc-50/80 px-4 py-2 dark:bg-zinc-900/80">
        <span className="text-muted-foreground text-xs">
          {toolTimestamp
            ? formatTimestamp(toolTimestamp)
            : assistantTimestamp
              ? formatTimestamp(assistantTimestamp)
              : ''}
        </span>
      </div>
    </Card>
  );
}
