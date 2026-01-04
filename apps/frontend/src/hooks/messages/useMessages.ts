import { useQuery, useMutation } from "@tanstack/react-query";
import { threadKeys } from "../threads/keys";
import { addUserMessage, getMessages, type Message } from "@/lib/api/threads";

export const useMessagesQuery = (threadId: string, options?) => {
  return useQuery<Message[]>({
    queryKey: threadKeys.messages(threadId),
    queryFn: () => getMessages(threadId),
    enabled: !!threadId,
    retry: (failureCount, error: any) => {
      const errorStr = error?.message?.toLowerCase() || '';
      const is404 = errorStr.includes('404') || errorStr.includes('not found');
      if (is404 && failureCount < 5) {
        return true;
      }
      return failureCount < 1;
    },
    retryDelay: (attemptIndex, error: any) => {
      const errorStr = error?.message?.toLowerCase() || '';
      const is404 = errorStr.includes('404') || errorStr.includes('not found');
      if (is404) {
        return Math.min(500 * (attemptIndex + 1), 2000);
      }
      return 1000;
    },
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    ...options,
  });
};

export const useAddUserMessageMutation = () => {
  return useMutation<void, Error, { threadId: string; message: string }>({
    mutationFn: ({
      threadId,
      message,
    }: {
      threadId: string;
      message: string;
    }) => addUserMessage(threadId, message)
  });
};

