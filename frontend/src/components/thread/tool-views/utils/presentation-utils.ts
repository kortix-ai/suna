import { backendApi } from "@/lib/api-client";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

export enum DownloadFormat {
  PDF = 'pdf',
  PPTX = 'pptx',
  GOOGLE_SLIDES = 'google-slides',
}

/**
 * Utility functions for handling presentation slide file paths
 */

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
  
  const match = filePath.match(/^presentations\/([^\/]+)\/slide_(\d+)\.html$/i);
  if (match) {
    return {
      isValid: true,
      presentationName: match[1],
      slideNumber: parseInt(match[2], 10)
    };
  }
  
  return { isValid: false, presentationName: null, slideNumber: null };
}

/**
 * Creates modified tool content for PresentationViewer from presentation slide data
 * @param presentationName - Name of the presentation
 * @param filePath - Path to the slide file
 * @param slideNumber - Slide number
 * @returns JSON stringified tool content that matches expected structure
 */
export function createPresentationViewerToolContent(
  presentationName: string,
  filePath: string,
  slideNumber: number
): string {
  const mockToolOutput = {
    presentation_name: presentationName,
    presentation_path: filePath,
    slide_number: slideNumber,
    presentation_title: `Slide ${slideNumber}`
  };

  return JSON.stringify({
    result: {
      output: JSON.stringify(mockToolOutput),
      success: true
    },
    tool_name: 'presentation-viewer'
  });
}

/**
 * Downloads a presentation as PDF or PPTX
 * @param sandboxUrl - The sandbox URL for the API endpoint
 * @param presentationPath - The path to the presentation in the workspace
 * @param presentationName - The name of the presentation for the downloaded file
 * @param format - The format to download the presentation as
 * @returns Promise that resolves when download is complete
 */
export async function downloadPresentation(
  format: DownloadFormat,
  sandboxUrl: string, 
  presentationPath: string, 
  presentationName: string
): Promise<void> {
  try {
    const response = await fetch(`${sandboxUrl}/presentation/convert-to-${format}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        presentation_path: presentationPath,
        download: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to download ${format}`);
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${presentationName}.${format}`;
    a.click();
    window.URL.revokeObjectURL(url);
    toast.success(`Downloaded ${presentationName} as ${format.toUpperCase()}`, {
      duration: 8000,
    });
  } catch (error) {
    console.error(`Error downloading ${format}:`, error);
    throw error; // Re-throw to allow calling code to handle
  }
}

export const handleGoogleAuth = async (presentationPath: string, sandboxUrl: string) => {
  try {
    // Store intent to upload to Google Slides after OAuth
    sessionStorage.setItem('google_slides_upload_intent', JSON.stringify({
      presentation_path: presentationPath,
      sandbox_url: sandboxUrl
    }));
    
    // Pass the current URL to the backend so it can be included in the OAuth state
    const currentUrl = encodeURIComponent(window.location.href);
    const response = await backendApi.get(`/google/auth-url?return_url=${currentUrl}`);
    
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to get auth URL');
    }
    
    const { auth_url } = response.data;
    
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
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    // Use proper backend API client with authentication and extended timeout for PPTX generation
    const response = await backendApi.post('/presentation-tools/convert-and-upload-to-slides', {
      presentation_path: presentationPath,
      sandbox_url: sandboxUrl,
    }, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
      timeout: 180000, // 3 minutes timeout for PPTX generation (longer than backend's 2 minute timeout)
    });

    if (!response.success) {
      throw new Error('Failed to upload to Google Slides');
    }

    const result = response.data;
    
    if (!result.success && !result.is_api_enabled) {
      toast.info('Redirecting to Google authentication...', {
        duration: 3000,
      });
      handleGoogleAuth(presentationPath, sandboxUrl);
      return {
        success: false,
        redirected_to_auth: true,
        message: 'Redirecting to Google authentication'
      };
    }
    
    if (result.google_slides_url) {
      // Always show rich success toast - this is universal
      toast.success('🎉 Presentation uploaded successfully!', {
        action: {
          label: 'Open in Google Slides',
          onClick: () => window.open(result.google_slides_url, '_blank'),
        },
        duration: 20000,
      });
      
      // Extract presentation name from path for display
      const presentationName = presentationPath.split('/').pop() || 'presentation';
      
      return {
        success: true,
        google_slides_url: result.google_slides_url,
        message: `"${presentationName}" uploaded successfully`
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
