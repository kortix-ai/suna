import { handleApiError } from '../error-handler';
import { transcribeAudio as sdkTranscribeAudio, type TranscriptionResponse } from '@kortix/sdk/projects-client';

export type { TranscriptionResponse };

// The actual upload + error-shape lives in the SDK
// (packages/sdk/src/platform/projects-client/transcription.ts). This wrapper
// stays web-local only to route failures through web's `handleApiError` toast.
export const transcribeAudio = async (audioFile: File): Promise<TranscriptionResponse> => {
  try {
    return await sdkTranscribeAudio(audioFile);
  } catch (error) {
    console.error('Failed to transcribe audio:', error);
    handleApiError(error, { operation: 'transcribe audio', resource: 'speech-to-text' });
    throw error;
  }
};
