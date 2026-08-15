'use client';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import { parseImageOutput } from '@/features/session/image-output-path';
import {
  BasicTool,
  isLocalSandboxFilePath,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ImageIcon } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

const TITLE_BY_ACTION: Record<string, string> = {
  generate: 'Generate Image',
  edit: 'Edit Image',
  upscale: 'Upscale Image',
  remove_bg: 'Remove Background',
};

export function ImageGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const prompt = input.prompt as string | undefined;
  const action = input.action as string | undefined;

  const { imagePath, directUrl } = useMemo(() => parseImageOutput(output), [output]);

  const isLocalPath = imagePath ? isLocalSandboxFilePath(imagePath) : false;
  const fileContentPath = useMemo(() => {
    if (!isLocalPath || !imagePath || directUrl) return null;
    return imagePath.replace(/^\/workspace\//, '');
  }, [isLocalPath, imagePath, directUrl]);
  const { data: fileContentData, isLoading: isImageLoading } = useFileContent(fileContentPath, {
    enabled: !!fileContentPath,
  });

  const imageUrl = useMemo(() => {
    if (fileContentData?.encoding === 'base64' && fileContentData?.content) {
      const binary = atob(fileContentData.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: fileContentData.mimeType || 'image/webp',
      });
      return URL.createObjectURL(blob);
    }
    return null;
  }, [fileContentData]);

  const displayImageSrc = directUrl || imageUrl || '';

  return (
    <BasicTool
      icon={<ImageIcon className="size-3.5 shrink-0" />}
      trigger={{
        title: TITLE_BY_ACTION[action ?? ''] || 'Image Gen',
        subtitle: prompt?.slice(0, 60),
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {imagePath || directUrl ? (
        <ToolResultCard bodyClassName="p-1">
          {displayImageSrc ? (
            <img
              src={displayImageSrc}
              alt={String(prompt || 'Generated image')}
              className="max-h-64 rounded-sm object-contain"
            />
          ) : isImageLoading ? (
            <div className="px-2 py-1.5 text-xs">
              <TextShimmer duration={1} spread={2} className="text-xs">
                {tHardcodedUi.raw(
                  'componentsSessionToolRenderers.line4414JsxTextLoadingImagePreview',
                )}
              </TextShimmer>
            </div>
          ) : (
            <div className="text-muted-foreground px-2 py-1.5 font-mono text-xs break-all">
              {imagePath}
            </div>
          )}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="image_gen" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
