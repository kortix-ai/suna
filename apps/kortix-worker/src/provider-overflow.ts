import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { isCompactionOverflow } from './compaction-overflow';

function hasContent(message: AssistantMessage): boolean {
  return message.content.some(part => part.type === 'toolCall' ||
    (part.type === 'text' ? part.text.length > 0 : part.thinking.length > 0));
}

export function recoverProviderOverflow(
  initial: AssistantMessageEventStream,
  recover: (error: AssistantMessage) => Promise<AssistantMessageEventStream | null>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  let last = fauxAssistantMessage('');
  const consume = async (stream: AssistantMessageEventStream, mayRecover: boolean): Promise<void> => {
    const buffered: AssistantMessageEvent[] = [];
    let visible = false;
    const flush = () => {
      for (const event of buffered.splice(0)) output.push(event);
    };
    for await (const event of stream) {
      if ('partial' in event) last = event.partial;
      if (event.type === 'error') {
        last = event.error;
        if (mayRecover && !visible && !signal?.aborted && !hasContent(event.error) &&
          event.error.stopReason === 'error' && isCompactionOverflow(new Error(event.error.errorMessage ?? ''))) {
          const replacement = await recover(event.error);
          signal?.throwIfAborted();
          if (replacement) {
            await consume(replacement, false);
            return;
          }
        }
        flush();
        output.push(event);
      } else if (event.type === 'done') {
        flush();
        last = event.message;
        output.push(event);
      } else {
        visible ||= event.type.startsWith('toolcall_') || hasContent(event.partial) || buffered.length >= 64;
        if (visible) {
          flush();
          output.push(event);
        } else {
          buffered.push(structuredClone(event));
        }
      }
    }
    flush();
    output.end(await stream.result());
  };
  void consume(initial, true).catch(error => {
    const aborted = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
    const message: AssistantMessage = {
      ...last,
      stopReason: aborted ? 'aborted' : 'error',
      errorMessage: `Context overflow recovery failed: ${String(error?.message ?? error).slice(0, 4096)}`,
    };
    output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
  });
  return output;
}
