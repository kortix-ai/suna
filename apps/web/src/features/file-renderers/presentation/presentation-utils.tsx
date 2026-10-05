import { errorToast, infoToast, successToast } from '@/components/ui/toast';
import type { UiTranslator } from '@/i18n/translator';
import { convertRuntimePresentation } from '@kortix/sdk';

export enum DownloadFormat {
  PDF = 'pdf',
  PPTX = 'pptx',
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
