/**
 * Google Slides export. The API removed `/v1/google/auth-url` and
 * `/v1/presentation-tools/*`; these exports remain for import compatibility
 * until the next major. Export a deck as PDF or PPTX instead
 * (`convertRuntimePresentation`).
 */
import { retiredEndpointError } from '../../http/api/errors';

const INSTEAD = 'Export the deck as PDF or PPTX with convertRuntimePresentation().';

/** @deprecated Google Slides export was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function getGoogleAuthUrl(_returnUrl: string): Promise<{ auth_url?: string }> {
  throw retiredEndpointError('getGoogleAuthUrl', INSTEAD);
}

export interface GoogleSlidesUploadResult {
  success: boolean;
  is_api_enabled?: boolean;
  google_slides_url?: string;
  message?: string;
  [key: string]: unknown;
}

/** @deprecated Google Slides export was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function convertPresentationToGoogleSlides(
  _presentationPath: string,
  _sandboxUrl: string,
): Promise<GoogleSlidesUploadResult> {
  throw retiredEndpointError('convertPresentationToGoogleSlides', INSTEAD);
}
