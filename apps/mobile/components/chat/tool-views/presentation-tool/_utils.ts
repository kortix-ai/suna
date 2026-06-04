import { Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { API_URL, getAuthHeaders } from '@/api/config';
import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';
import { log } from '@/lib/logger';

export enum DownloadFormat {
  PDF = 'pdf',
  PPTX = 'pptx',
  GOOGLE_SLIDES = 'google-slides',
}

export interface Slide {
  slide_number: number;
  title: string;
  content?: string;
  description?: string;
  notes?: string;
  layout?: string;
}

export interface PresentationData {
  presentation_id?: string;
  presentation_name?: string;
  title?: string;
  subtitle?: string;
  slides?: Slide[];
  slide?: Slide;
  total_slides?: number;
  slide_count?: number;
  message?: string;
  outline?: any;
  success: boolean;
}

export interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

export interface PresentationMetadata {
  presentation_name: string;
  title: string;
  description: string;
  slides: Record<string, SlideMetadata>;
  created_at: string;
  updated_at: string;
}

/**
 * Sanitizes a filename to match backend directory naming convention
 */
export const sanitizeFilename = (name: string): string => {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
};

/**
 * Constructs a URL for accessing files from the sandbox
 */
export const constructHtmlPreviewUrl = (sandboxUrl: string, filePath: string): string => {
  const processedPath = filePath.replace(/^\/workspace\//, '');
  const pathSegments = processedPath.split('/').map(segment => encodeURIComponent(segment));
  const encodedPath = pathSegments.join('/');
  return `${sandboxUrl}/${encodedPath}`;
};

/**
 * Downloads a presentation as PDF or PPTX
 * Uses POST request to sandbox API (matching frontend implementation)
 */
export async function downloadPresentation(
  format: DownloadFormat.PDF | DownloadFormat.PPTX,
  sandboxUrl: string, 
  presentationPath: string, 
  presentationName: string
): Promise<void> {
  try {
    const exportUrl = `${sandboxUrl}/presentation/convert-to-${format}`;
    
    log.log(`📤 [downloadPresentation] Exporting ${format}:`, exportUrl);
    
    // POST request to sandbox API (matching frontend)
    const response = await fetch(exportUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        presentation_path: presentationPath,
        download: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to download ${format}: ${response.status}`);
    }

    // Get the blob
    const blob = await response.blob();
    
    // Convert blob to base64 and save to file system
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      
      reader.onloadend = async () => {
        try {
          const base64data = reader.result as string;
          const base64Content = base64data.split(',')[1];
          
          const fileName = `${presentationName}.${format}`;
          const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
          
          await FileSystem.writeAsStringAsync(fileUri, base64Content, {
            encoding: FileSystem.EncodingType.Base64,
          });
          
          // Use expo-sharing for native share sheet
          const isSharingAvailable = await Sharing.isAvailableAsync();
          
          if (isSharingAvailable) {
            await Sharing.shareAsync(fileUri, {
              mimeType: format === 'pdf' 
                ? 'application/pdf' 
                : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              dialogTitle: `Save ${fileName}`,
            });
          } else {
            Alert.alert('Success', `${fileName} has been saved.`);
          }
          
          resolve();
        } catch (saveError) {
          log.error('Error saving file:', saveError);
          reject(saveError);
        }
      };
      
      reader.onerror = () => {
        reject(new Error('Failed to read blob'));
      };
    });
  } catch (error) {
    log.error(`Error downloading ${format}:`, error);
    throw error;
  }
}

/**
 * Uploads presentation to Google Slides via backend API
 * (matching frontend's handleGoogleSlidesUpload)
 */
export async function handleGoogleSlidesUpload(
  sandboxUrl: string, 
  presentationPath: string
): Promise<{ success: boolean; google_slides_url?: string; needs_auth?: boolean; auth_url?: string; message?: string }> {
  if (!sandboxUrl || !presentationPath) {
    throw new Error('Missing required parameters');
  }
  
  try {
    const authHeaders = await getAuthHeaders();
    
    log.log('📤 [handleGoogleSlidesUpload] Uploading to Google Slides');
    
    const response = await fetch(`${API_URL}/presentation-tools/convert-and-upload-to-slides`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        presentation_path: presentationPath,
        sandbox_url: sandboxUrl,
      }),
    });

    const result = await response.json();
    
    // Check if Google auth is needed (either from error or success:false with is_api_enabled:false)
    if ((!response.ok && result.is_api_enabled === false) || 
        (result.success === false && result.is_api_enabled === false)) {
      // Try to get the auth URL
      try {
        const authResponse = await fetch(`${API_URL}/google/auth-url`, {
          method: 'GET',
          headers: authHeaders,
        });
        
        if (authResponse.ok) {
          const authData = await authResponse.json();
          return {
            success: false,
            needs_auth: true,
            auth_url: authData.auth_url,
            message: 'Google authentication required',
          };
        }
      } catch {
        // Ignore auth URL fetch error
      }
      
      return {
        success: false,
        needs_auth: true,
        message: 'Google authentication required',
      };
    }
    
    if (!response.ok) {
      throw new Error(result.message || 'Failed to upload to Google Slides');
    }
    
    if (result.google_slides_url) {
      const presentationName = presentationPath.split('/').pop() || 'presentation';
      
      return {
        success: true,
        google_slides_url: result.google_slides_url,
        message: `"${presentationName}" uploaded successfully`,
      };
    }
    
    throw new Error(result.message || 'No Google Slides URL returned');
    
  } catch (error) {
    log.error('Error uploading to Google Slides:', error);
    throw error;
  }
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractPresentationData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): PresentationData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let data: any = {};
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      data = output;
    } else if (typeof output === 'string') {
      data = { message: output };
      
      const slideMatch = output.match(/Slide (\d+).*?created/i);
      if (slideMatch) {
        data.slide = {
          slide_number: parseInt(slideMatch[1]),
          title: args?.title || 'Slide',
          content: args?.content || args?.description
        };
      }
    }
  }
  
  const slideData = data.slide_data || data.slide;
  const outlineData = data.outline || data;
  
  let slides = data.slides || outlineData?.slides || (slideData ? [slideData] : []);
  
  if (slides.length === 0 && data.slide_number) {
    const singleSlide: Slide = {
      slide_number: data.slide_number,
      title: data.slide_title || args?.slide_title || args?.title || 'Slide',
      content: args?.content || args?.description,
      description: args?.description,
      notes: data.notes || args?.notes
    };
    slides = [singleSlide];
  }
  
  return {
    presentation_id: data.presentation_id || args?.presentation_id,
    presentation_name: data.presentation_name || args?.presentation_name,
    title: data.title || outlineData?.title || args?.title || args?.presentation_title,
    subtitle: data.subtitle || outlineData?.subtitle,
    slides,
    slide: slideData,
    total_slides: data.total_slides || data.slide_count || outlineData?.slide_count || slides?.length,
    slide_count: data.slide_count || outlineData?.slide_count || slides?.length,
    message: data.message || data.status,
    outline: outlineData,
    success: toolResult?.success ?? true
  };
}

/**
 * Parses a presentation slide path to extract presentation name and slide number
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
