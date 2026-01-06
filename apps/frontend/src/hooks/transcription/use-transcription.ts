import { useMutation } from '@tanstack/react-query';
import { transcribeAudio, TranscriptionResponse } from '@/lib/api/transcription';
import { handleApiError } from '@/lib/error-handler';

export const useTranscription = () => {
  return useMutation<
    TranscriptionResponse,
    Error,
    File
  >({
    mutationFn: transcribeAudio,
    onError: (error) => {
      handleApiError(error, { operation: 'transcribe audio', resource: 'speech-to-text' });
    }
  });
};
