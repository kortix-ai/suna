// Speech-to-text transcription — POSTs an audio file as multipart form-data.

import { backendApi } from '../../http/api-client';

export interface TranscriptionResponse {
  text: string;
}

export async function transcribeAudio(audioFile: File): Promise<TranscriptionResponse> {
  const formData = new FormData();
  formData.append('audio_file', audioFile);

  const response = await backendApi.upload<TranscriptionResponse>('/transcription', formData, {
    showErrors: true,
  });

  if (response.error) {
    throw new Error(
      `Error transcribing audio: ${response.error.message} (${response.error.status})`,
    );
  }

  return response.data!;
}
