import { useQuery, useMutation } from "@tanstack/react-query";
import { threadKeys } from "../threads/keys";
import { addUserMessage, getMessages, type Message } from "@/lib/api/threads";

export const useMessagesQuery = (threadId: string, options?) => {
  return useQuery<Message[]>({
    queryKey: threadKeys.messages(threadId),
    queryFn: () => getMessages(threadId),
    enabled: !!threadId,
    retry: 1,
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

