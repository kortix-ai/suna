import { getEnv } from '@/lib/env-config';
import { toast } from '@/lib/toast';
import {
  buildPresentationTemplateImageUrl,
  buildPresentationTemplatePdfUrl,
  convertPresentationToGoogleSlides,
  convertRuntimePresentation,
  getGoogleAuthUrl,
} from '@kortix/sdk';

export enum DownloadFormat {
  PDF = 'pdf',
  PPTX = 'pptx',
  GOOGLE_SLIDES = 'google-slides',
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
      slideNumber: Number.parseInt(match[2], 10),
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
    message: `Slide ${slideNumber} edited successfully`,
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
): Promise<void> {
  try {
    if (format === DownloadFormat.GOOGLE_SLIDES) {
      throw new Error('Google Slides uses the OAuth upload flow');
    }
    const blob = await convertRuntimePresentation(format, sandboxUrl, presentationPath, {
      onGenerating: () => {
        toast.info(`Generating ${format.toUpperCase()}… this can take a moment for large decks`, {
          duration: 6000,
        });
      },
    });
    saveBlob(blob, `${presentationName}.${format}`);
    toast.success(`Downloaded ${presentationName} as ${format.toUpperCase()}`, {
      duration: 8000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[downloadPresentation] Error downloading ${format}:`, error);
    toast.error(message, { duration: 10000 });
    throw error; // Re-throw to allow calling code to handle
  }
}

export const handleGoogleAuth = async (presentationPath: string, sandboxUrl: string) => {
  try {
    // Store intent to upload to Google Slides after OAuth
    sessionStorage.setItem(
      'google_slides_upload_intent',
      JSON.stringify({
        presentation_path: presentationPath,
        sandbox_url: sandboxUrl,
      }),
    );

    // Pass the current URL to the backend so it can be included in the OAuth state
    const { auth_url } = await getGoogleAuthUrl(window.location.href);

    if (auth_url) {
      window.location.href = auth_url;
      return;
    }
  } catch (error) {
    console.error('Error initiating Google auth:', error);
    toast.error('Failed to initiate Google authentication');
  }
};

export const handleGoogleSlidesUpload = async (sandboxUrl: string, presentationPath: string) => {
  if (!sandboxUrl || !presentationPath) {
    throw new Error('Missing required parameters');
  }

  try {
    const result = await convertPresentationToGoogleSlides(presentationPath, sandboxUrl);

    if (!result.success && !result.is_api_enabled) {
      toast.info('Redirecting to Google authentication...', {
        duration: 3000,
      });
      handleGoogleAuth(presentationPath, sandboxUrl);
      return {
        success: false,
        redirected_to_auth: true,
        message: 'Redirecting to Google authentication',
      };
    }

    if (result.google_slides_url) {
      // Always show rich success toast - this is universal
      toast.success('🎉 Presentation uploaded successfully!', {
        action: {
          label: 'Open in Google Slides',
          onClick: () => window.open(result.google_slides_url, '_blank', 'noopener,noreferrer'),
        },
        duration: 20000,
      });

      // Extract presentation name from path for display
      const presentationName = presentationPath.split('/').pop() || 'presentation';

      return {
        success: true,
        google_slides_url: result.google_slides_url,
        message: `"${presentationName}" uploaded successfully`,
      };
    }

    // Only throw error if no Google Slides URL was returned
    throw new Error(result.message || 'No Google Slides URL returned');
  } catch (error) {
    console.error('Error uploading to Google Slides:', error);

    // Show error toasts - this is also universal
    if (error instanceof Error && error.message.includes('not authenticated')) {
      toast.error('Please authenticate with Google first');
    } else {
      toast.error('Failed to upload to Google Slides');
    }

    // Re-throw for any calling code that needs to handle it
    throw error;
  }
};
