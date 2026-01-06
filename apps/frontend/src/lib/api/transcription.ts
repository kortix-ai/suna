import { handleApiError } from '../error-handler';
import { backendApi } from '../api-client';

export interface TranscriptionResponse {
  text: string;
}

export const transcribeAudio = async (audioFile: File): Promise<TranscriptionResponse> => {
  try {
    const formData = new FormData();
    formData.append('audio_file', audioFile);

    const response = await backendApi.upload<TranscriptionResponse>(
      '/transcription',
      formData,
      { showErrors: true }
    );

    if (response.error) {
      throw new Error(
        `Error transcribing audio: ${response.error.message} (${response.error.status})`,
      );
    }

    return response.data!;
  } catch (error) {
    console.error('Failed to transcribe audio:', error);
    handleApiError(error, { operation: 'transcribe audio', resource: 'speech-to-text' });
    throw error;
  }
};

