import { handleApiError } from '@/lib/error-handler';
import { type TranscriptionResponse, transcribeAudio } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';

export const useTranscription = () => {
  return useMutation<TranscriptionResponse, Error, File>({
    mutationFn: transcribeAudio,
    onError: (error) => {
      handleApiError(error, { operation: 'transcribe audio', resource: 'speech-to-text' });
    },
  });
};
