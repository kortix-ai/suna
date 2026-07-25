import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export async function getGoogleAuthUrl(returnUrl: string): Promise<{ auth_url?: string }> {
  return unwrap(
    await backendApi.get<{ auth_url?: string }>(
      `/google/auth-url?return_url=${encodeURIComponent(returnUrl)}`,
    ),
    'Failed to get Google auth URL',
  );
}

export interface GoogleSlidesUploadResult {
  success: boolean;
  is_api_enabled?: boolean;
  google_slides_url?: string;
  message?: string;
  [key: string]: unknown;
}

export async function convertPresentationToGoogleSlides(
  presentationPath: string,
  sandboxUrl: string,
): Promise<GoogleSlidesUploadResult> {
  return unwrap(
    await backendApi.post<GoogleSlidesUploadResult>(
      '/presentation-tools/convert-and-upload-to-slides',
      { presentation_path: presentationPath, sandbox_url: sandboxUrl },
      { timeout: 180000 },
    ),
    'Failed to upload to Google Slides',
  );
}
