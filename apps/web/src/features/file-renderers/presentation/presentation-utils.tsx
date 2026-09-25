import { errorToast, infoToast, successToast } from '@/components/ui/toast';
import type { UiTranslator } from '@/i18n/translator';
import { getEnv } from '@/lib/env-config';
import {
  buildPresentationTemplateImageUrl,
  buildPresentationTemplatePdfUrl,
  convertRuntimePresentation,
} from '@kortix/sdk';

export enum DownloadFormat {
  PDF = 'pdf',
  PPTX = 'pptx',
}

/**
 * Utility functions for handling presentation slide file paths
 */

/**
 * Gets the PDF URL for a presentation template
 * @param templateId - The template ID
 * @returns The full PDF URL with parameters
 */
export const getPdfUrl = (templateId: string): string => {
  return buildPresentationTemplatePdfUrl(getEnv().BACKEND_URL, templateId);
};

/**
 * Gets the image URL for a presentation template
 * @param templateId - The template ID
 * @param hasImage - Whether the template has an image
 * @returns The full image URL
 */
export const getImageUrl = (templateId: string, hasImage: boolean): string => {
  return buildPresentationTemplateImageUrl(getEnv().BACKEND_URL, templateId);
};

/**
 * Validates and extracts presentation info from a file path in a single operation
 * @param filePath - The file path to validate and extract information from
 * @returns Object containing validation result and extracted data
 */
export function parsePresentationSlidePath(filePath: string | null): {
  isValid: boolean;
  presentationName: string | null;
  slideNumber: number | null;
} {
  if (!filePath) {
    return { isValid: false, presentationName: null, slideNumber: null };
  }

  // Match patterns like:
  // - presentations/[name]/slide_01.html
  // - /workspace/presentations/[name]/slide_01.html
  // - ./presentations/[name]/slide_01.html
  // - any/path/presentations/[name]/slide_01.html
  const match = filePath.match(/presentations\/([^\/]+)\/slide_(\d+)\.html$/i);
  if (match) {
    return {
      isValid: true,
      presentationName: match[1],
      slideNumber: parseInt(match[2], 10),
    };
  }

  return { isValid: false, presentationName: null, slideNumber: null };
}

/**
 * Creates modified tool content for PresentationViewer from presentation slide data
 * @param presentationName - Name of the presentation
 * @param filePath - Path to the slide file
 * @param slideNumber - Slide number
 * @returns JSON stringified tool content that matches expected structure for PresentationViewer
 */
export function createPresentationViewerToolContent(
  presentationName: string,
  filePath: string,
  slideNumber: number,
  tI18nComplete: UiTranslator,
): string {
  // PresentationViewer expects presentation_path to be the directory, not the file
  // e.g., "presentations/mypresentation" not "presentations/mypresentation/slide_01.html"
  const presentationPath = `presentations/${presentationName}`;

  // Return a flat structure that PresentationViewer can directly parse
  const toolOutput = {
    presentation_name: presentationName,
    presentation_path: presentationPath,
    slide_number: slideNumber,
    slide_file: filePath,
    presentation_title: presentationName,
    message: tI18nComplete('text854a397472d0', { value0: slideNumber }),
  };

  return JSON.stringify(toolOutput);
}

/** Trigger a browser "save as" for a generated blob. */
function saveBlob(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

/**
 * Downloads a presentation as PDF or PPTX.
 *
 * The sandbox endpoint runs the (slow) conversion in the background and answers
 * each POST fast — 200 + the file when it's ready, 202 while it's still
 * generating — so it never trips the preview-proxy's per-attempt timeout. We
 * poll until the file is ready (or a hard timeout), then save it.
 *
 * @param format - The format to download the presentation as
 * @param sandboxUrl - The sandbox URL for the API endpoint
 * @param presentationPath - The path to the presentation in the workspace
 * @param presentationName - The name of the presentation for the downloaded file
 * @returns Promise that resolves when the download has started
 */
export async function downloadPresentation(
  format: DownloadFormat,
  sandboxUrl: string,
  presentationPath: string,
  presentationName: string,
  tI18nComplete: UiTranslator,
): Promise<void> {
  try {
    const blob = await convertRuntimePresentation(format, sandboxUrl, presentationPath, {
      onGenerating: () => {
        infoToast(tI18nComplete('text72662e145fd4', { value0: format.toUpperCase() }), {
          duration: 6000,
        });
      },
    });
    saveBlob(blob, `${presentationName}.${format}`);
    successToast(
      tI18nComplete('text979f490e2ae0', { value0: presentationName, value1: format.toUpperCase() }),
      {
        duration: 8000,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[downloadPresentation] Error downloading ${format}:`, error);
    errorToast(message, { duration: 10000 });
    throw error; // Re-throw to allow calling code to handle
  }
}
