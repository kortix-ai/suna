import { createMutationHook } from '@/hooks/use-query';
import { transcribeAudio, TranscriptionResponse } from '@/lib/api';

export const useTranscription = createMutationHook<
  TranscriptionResponse,
  File
>(
  transcribeAudio,
  {
    errorContext: { operation: 'transcribe audio', resource: 'speech-to-text' },
  }
); 