import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import {
  openEventStream,
  type EventStreamHandle,
  type MessageWithParts,
  type OpenCodeEvent,
  type Part,
  type PermissionRequest,
  type QuestionRequest,
} from '@kortix/sdk';
import { unwrapRuntime, withKortixScope } from '../api/sdk.ts';
import { surfaceApiError } from '../command-helpers.ts';
import type { ResolvedSession } from './sessions-chat.ts';
import { sessionPromptDefaults } from './sessions-files.ts';
import { wireMessageId } from './sessions-queue.ts';

type Pending =
  | { kind: 'question'; request: QuestionRequest; answers: string[][] }
  | { kind: 'permission'; request: PermissionRequest };

const help =
  'Enter a message to send. /stop stops the turn. /reject dismisses the current request. /exit or Ctrl-D detaches.\n';
const clean = (text: string) =>
  stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

export async function runPiTerminal(
  resolved: ResolvedSession,
  options: { agent?: string } = {},
): Promise<number> {
  const { handle, runtime, opencodeSessionId: sessionID } = resolved;
  const scope = <T>(fn: () => Promise<T>) => withKortixScope(resolved.auth, fn);
  const write = (text: string) => process.stdout.write(clean(text));
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const lines = input[Symbol.asyncIterator]();
  input.pause();
  const parts = new Map<string, string>();
  const assistants = new Set<string>();
  const displayed = new Set<string>();
  const finishedRequests = new Set<string>();
  const pending = new Map<string, Pending>();
  let currentRequest: string | undefined;
  let stream: EventStreamHandle | undefined;
  let closed = false;
  let stopping: Promise<void> | undefined;
  let rehydrating: Promise<void> | undefined;
  let requestRevision = 0;

  const showPending = (force = false) => {
    const next = pending.values().next().value as Pending | undefined;
    if (!next) {
      currentRequest = undefined;
      return;
    }
    if (!force && currentRequest === next.request.id) return;
    currentRequest = next.request.id;
    if (next.kind === 'permission') {
      const details = JSON.stringify(next.request.metadata ?? {}, null, 2);
      write(`\nPermission: ${next.request.permission}\n${next.request.patterns.join('\n')}\n`);
      if (details !== '{}')
        write(details.slice(0, 6000) + (details.length > 6000 ? '\n[details truncated]\n' : '\n'));
      write('Reply once, always, or reject: ');
      return;
    }
    const question = next.request.questions[next.answers.length];
    if (!question) return;
    write(`\n${question.header}: ${question.question}\n`);
    for (const [index, option] of question.options.entries()) {
      write(
        `  ${index + 1}. ${option.label}${option.description ? ' — ' + option.description : ''}\n`,
      );
    }
    write(question.multiple ? 'Choose numbers separated by commas' : 'Choose an option number');
    if (question.custom !== false) write(' or enter your own answer');
    write(' (/reject to dismiss): ');
  };

  const addPending = (item: Pending) => {
    if (item.request.sessionID !== sessionID || finishedRequests.has(item.request.id)) return;
    if (!pending.has(item.request.id)) {
      pending.set(item.request.id, item);
      requestRevision += 1;
    }
    showPending();
  };

  const removePending = (id: string) => {
    requestRevision += 1;
    finishedRequests.add(id);
    pending.delete(id);
    showPending();
  };

  const renderPart = (part: Part) => {
    if (part.sessionID !== sessionID || !assistants.has(part.messageID)) return;
    if (part.type === 'text' && !part.synthetic) {
      const before = parts.get(part.id) ?? '';
      if (before === part.text || before.startsWith(part.text)) return;
      if (!displayed.has(part.messageID)) {
        write('\nassistant\n');
        displayed.add(part.messageID);
      }
      write(part.text.startsWith(before) ? part.text.slice(before.length) : '\n' + part.text);
      parts.set(part.id, part.text);
    } else if (part.type === 'tool') {
      const label = `${part.tool}: ${part.state.status}`;
      if (parts.get(part.id) === label) return;
      parts.set(part.id, label);
      write(`\n[${label}]\n`);
    }
  };

  const renderMessage = (message: MessageWithParts) => {
    if (message.info.sessionID !== sessionID) return;
    if (message.info.role === 'assistant') {
      assistants.add(message.info.id);
      for (const part of message.parts) renderPart(part);
    } else if (!displayed.has(message.info.id)) {
      displayed.add(message.info.id);
      const text = message.parts
        .filter((part) => part.type === 'text' && !part.synthetic)
        .map((part) => (part as { text: string }).text)
        .join('\n');
      if (text) write(`\nyou\n${text}\n`);
    }
  };

  const hydrate = (includeMessages = true) => {
    if (rehydrating) return rehydrating;
    const revision = requestRevision;
    rehydrating = scope(async () => {
      const options = { signal: AbortSignal.timeout(20_000) };
      const [messages, questions, permissions] = await Promise.all([
        includeMessages ? runtime.session.messages({ sessionID, limit: 20 }, options) : undefined,
        runtime.question.list({}, options),
        runtime.permission.list({}, options),
      ]);
      if (closed) return;
      if (messages) for (const message of unwrapRuntime(messages)) renderMessage(message);
      const questionRows = unwrapRuntime(questions);
      const permissionRows = unwrapRuntime(permissions);
      if (revision === requestRevision) {
        const ids = new Set(
          [...questionRows, ...permissionRows]
            .filter((request) => request.sessionID === sessionID)
            .map((request) => request.id),
        );
        for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
      }
      for (const request of questionRows) addPending({ kind: 'question', request, answers: [] });
      for (const request of permissionRows) addPending({ kind: 'permission', request });
      showPending();
    }).finally(() => {
      rehydrating = undefined;
    });
    return rehydrating;
  };

  const onEvent = (event: OpenCodeEvent) => {
    if (closed) return;
    if (event.type === 'server.connected') {
      void hydrate(false).catch(surfaceApiError);
    } else if (event.type === 'message.updated' && event.properties.info.sessionID === sessionID) {
      const info = event.properties.info;
      if (info.role === 'assistant') {
        assistants.add(info.id);
        if (info.error) write(`\n[error: ${JSON.stringify(info.error)}]\n`);
      }
    } else if (event.type === 'message.part.updated') {
      renderPart(event.properties.part);
    } else if (event.type === 'message.part.delta') {
      const delta = event.properties;
      if (
        delta.sessionID !== sessionID ||
        delta.field !== 'text' ||
        !assistants.has(delta.messageID)
      )
        return;
      renderPart({
        id: delta.partID,
        messageID: delta.messageID,
        sessionID,
        type: 'text',
        text: (parts.get(delta.partID) ?? '') + delta.delta,
      });
    } else if (event.type === 'question.asked') {
      addPending({ kind: 'question', request: event.properties, answers: [] });
    } else if (event.type === 'permission.asked') {
      addPending({ kind: 'permission', request: event.properties });
    } else if (
      (event.type === 'question.replied' ||
        event.type === 'question.rejected' ||
        event.type === 'permission.replied') &&
      event.properties.sessionID === sessionID
    ) {
      removePending(event.properties.requestID);
    } else if (
      event.type === 'session.status' &&
      event.properties.sessionID === sessionID &&
      event.properties.status.type === 'idle'
    ) {
      write('\n[ready]\n');
    } else if (
      event.type === 'session.error' &&
      (!event.properties.sessionID || event.properties.sessionID === sessionID)
    ) {
      write(`\n[error: ${JSON.stringify(event.properties.error)}]\n`);
    }
  };

  const stop = () => {
    if (stopping) return stopping;
    stopping = scope(async () => {
      unwrapRuntime(await runtime.session.abort({ sessionID }));
      for (const id of pending.keys()) finishedRequests.add(id);
      pending.clear();
      requestRevision += 1;
      currentRequest = undefined;
      write('\n[turn stopped]\n');
    }).finally(() => {
      stopping = undefined;
    });
    return stopping;
  };
  const onInterrupt = () => {
    void stop().catch(surfaceApiError);
  };

  try {
    write(`\nConnected to Pi: ${resolved.session.name ?? resolved.session.session_id}\n${help}`);
    await hydrate();
    stream = await scope(async () =>
      openEventStream({
        client: runtime,
        onEvent,
        onGapRehydrate: () => {
          void hydrate().catch(surfaceApiError);
        },
        onParked: () => {
          write('\n[connection closed; reconnect with kortix sessions connect]\n');
          input.close();
        },
      }),
    );
    process.on('SIGINT', onInterrupt);
    input.on('SIGINT', onInterrupt);
    input.resume();
    for await (const raw of { [Symbol.asyncIterator]: () => lines }) {
      const text = raw.trim();
      if (!text) continue;
      if (text === '/exit' || text === 'exit' || text === 'quit') break;
      try {
        if (text === '/help') {
          write(help);
          showPending(true);
          continue;
        }
        if (text === '/stop') {
          await stop();
          continue;
        }
        const active = pending.values().next().value as Pending | undefined;
        if (active) {
          if (text === '/reject') {
            await scope(async () =>
              unwrapRuntime(
                active.kind === 'question'
                  ? await runtime.question.reject({ requestID: active.request.id })
                  : await runtime.permission.reply({
                      requestID: active.request.id,
                      reply: 'reject',
                    }),
              ),
            );
          } else if (active.kind === 'permission') {
            if (text !== 'once' && text !== 'always' && text !== 'reject') {
              write('\nReply once, always, or reject.\n');
              continue;
            }
            await scope(async () =>
              unwrapRuntime(
                await runtime.permission.reply({ requestID: active.request.id, reply: text }),
              ),
            );
          } else {
            const question = active.request.questions[active.answers.length];
            const indexes = text.split(',').map((value) => value.trim());
            let answer: string[];
            if (
              question.options.length > 0 &&
              (question.multiple || indexes.length === 1) &&
              indexes.every((value) => /^\d+$/.test(value) && question.options[Number(value) - 1])
            ) {
              answer = [
                ...new Set(indexes.map((value) => question.options[Number(value) - 1].label)),
              ];
            } else if (
              question.custom !== false ||
              question.options.some((option) => option.label === text)
            ) {
              answer = [text];
            } else {
              write('\nChoose a listed option.\n');
              continue;
            }
            const answers = [...active.answers, answer];
            if (answers.length < active.request.questions.length) {
              active.answers = answers;
              showPending(true);
              continue;
            }
            await scope(async () =>
              unwrapRuntime(
                await runtime.question.reply({ requestID: active.request.id, answers }),
              ),
            );
          }
          removePending(active.request.id);
          write('\n[reply sent]\n');
          continue;
        }
        if (text === '/reject') {
          write('\n[no pending request]\n');
          continue;
        }
        const defaults = sessionPromptDefaults(resolved.session);
        await scope(() =>
          handle.prompts.create({
            clientMessageId: crypto.randomUUID(),
            messageId: wireMessageId(),
            remintOnDelivery: true,
            parts: [{ type: 'text', text }],
            overrides: { ...defaults, ...options },
            clientSentAtMs: Date.now(),
          }),
        );
        write('\n[prompt queued]\n');
      } catch (error) {
        surfaceApiError(error);
        showPending(true);
      }
    }
    return 0;
  } catch (error) {
    return surfaceApiError(error);
  } finally {
    closed = true;
    input.close();
    process.off('SIGINT', onInterrupt);
    input.off('SIGINT', onInterrupt);
    await stream?.close();
  }
}
