'use client';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import { parseImageOutput } from '@/features/session/image-output-path';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
  isLocalSandboxFilePath,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import {
  Image as ImageIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useMemo,
} from 'react';


export function ImageGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
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

  const titleMap: Record<string, string> = {
    generate: 'Generate Image',
    edit: 'Edit Image',
    upscale: 'Upscale Image',
    remove_bg: 'Remove Background',
  };

  return (
    <BasicTool
      icon={<ImageIcon className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: titleMap[action ?? ''] || 'Image Gen',
        subtitle: prompt?.slice(0, 60),
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {imagePath || directUrl ? (
        <div className="p-2">
          {displayImageSrc ? (
            <img
              src={displayImageSrc}
              alt={String(prompt || 'Generated image')}
              className="max-h-64 object-contain"
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
        </div>
      ) : isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="image_gen" />
      ) : output ? (
        <div className="p-2">
          <OutputBlock text={output} />
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);

