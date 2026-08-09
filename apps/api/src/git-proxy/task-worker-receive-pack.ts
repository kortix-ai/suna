/**
 * Task workers may push one command to their immutable session branch.
 *
 * Git receive-pack puts its update commands in pkt-lines before the packfile.
 * This parser reads only that bounded prelude. It does not contact or resolve
 * the provider until the command is accepted. The returned stream replays the
 * exact bytes and then streams the remaining pack with a hard total bound.
 */
export const TASK_WORKER_RECEIVE_PACK_MAX_PRELUDE_BYTES = 16 * 1024;
export const TASK_WORKER_RECEIVE_PACK_MAX_BODY_BYTES = 1024 * 1024 * 1024;
export const TASK_WORKER_RECEIVE_PACK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface TaskWorkerReceivePackCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export class TaskWorkerReceivePackError extends Error {
  readonly code = 'TASK_WORKER_RECEIVE_PACK_INVALID' as const;

  constructor(
    message: string,
    readonly status: 400 | 403 = 400,
  ) {
    super(message);
    this.name = 'TaskWorkerReceivePackError';
  }
}

function pktLength(header: Uint8Array): number {
  const text = String.fromCharCode(...header);
  if (!/^[0-9a-fA-F]{4}$/.test(text)) {
    throw new TaskWorkerReceivePackError('invalid receive-pack pkt-line length');
  }
  return Number.parseInt(text, 16);
}

function concat(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseCommand(payload: Uint8Array, first: boolean): TaskWorkerReceivePackCommand {
  if (payload.includes(0x0a) || payload.includes(0x0d)) {
    throw new TaskWorkerReceivePackError('receive-pack command contains a line break');
  }
  let commandBytes = payload;
  const nul = payload.indexOf(0);
  if (first) {
    if (nul < 0) {
      throw new TaskWorkerReceivePackError(
        'first receive-pack command has no capability separator',
      );
    }
    commandBytes = payload.subarray(0, nul);
  } else if (nul >= 0) {
    throw new TaskWorkerReceivePackError('unexpected capability separator in receive-pack command');
  }
  const command = new TextDecoder('ascii', { fatal: true }).decode(commandBytes);
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([^\0 ]+)$/.exec(command);
  const oldOid = match?.[1];
  const newOid = match?.[2];
  const ref = match?.[3];
  if (!oldOid || !newOid || !ref || oldOid.length !== newOid.length) {
    throw new TaskWorkerReceivePackError('invalid receive-pack update command');
  }
  return { oldOid, newOid, ref };
}

function validateCommand(command: TaskWorkerReceivePackCommand, workerSessionId: string): void {
  const allowedRef = `refs/heads/${workerSessionId}`;
  if (command.ref !== allowedRef) {
    throw new TaskWorkerReceivePackError(`task worker may push only ${allowedRef}`, 403);
  }
  if (/^0+$/.test(command.newOid)) {
    throw new TaskWorkerReceivePackError('task worker may not delete its branch', 403);
  }
}

/**
 * Parse and authorize the command prelude, then return an exact replay stream.
 * At most 16 KiB is copied for parsing. The packfile is never buffered here.
 */
export async function inspectTaskWorkerReceivePack(input: {
  body: ReadableStream<Uint8Array> | null;
  workerSessionId: string;
  contentLength?: string | null;
  maxPreludeBytes?: number;
  maxBodyBytes?: number;
}): Promise<{ command: TaskWorkerReceivePackCommand; body: ReadableStream<Uint8Array> }> {
  if (!input.body) throw new TaskWorkerReceivePackError('receive-pack request body is required');
  const maxPreludeBytes = input.maxPreludeBytes ?? TASK_WORKER_RECEIVE_PACK_MAX_PRELUDE_BYTES;
  const maxBodyBytes = input.maxBodyBytes ?? TASK_WORKER_RECEIVE_PACK_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxPreludeBytes) || maxPreludeBytes < 8) {
    throw new RangeError('maxPreludeBytes must be an integer of at least 8');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < maxPreludeBytes) {
    throw new RangeError('maxBodyBytes must be an integer at least maxPreludeBytes');
  }
  if (input.contentLength != null) {
    if (!/^\d+$/.test(input.contentLength)) {
      throw new TaskWorkerReceivePackError('invalid receive-pack content-length');
    }
    const declared = Number(input.contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBodyBytes) {
      throw new TaskWorkerReceivePackError('receive-pack request body is too large');
    }
  }

  const reader = input.body.getReader();
  const replay: Uint8Array[] = [];
  const preludeChunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let preludeSize = 0;
  let parsedOffset = 0;
  let prelude: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const commands: TaskWorkerReceivePackCommand[] = [];
  let complete = false;
  let acceptedCommand: TaskWorkerReceivePackCommand | null = null;

  try {
    while (!complete) {
      const next = await reader.read();
      if (next.done) throw new TaskWorkerReceivePackError('truncated receive-pack command prelude');
      const chunk = next.value;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBodyBytes) {
        throw new TaskWorkerReceivePackError('receive-pack request body is too large');
      }
      replay.push(chunk);

      // Copy only bytes still needed to find the command-list flush packet.
      const room = maxPreludeBytes - preludeSize;
      if (room <= 0)
        throw new TaskWorkerReceivePackError('receive-pack command prelude is too large');
      const copied = chunk.subarray(0, Math.min(chunk.byteLength, room));
      preludeChunks.push(copied);
      preludeSize += copied.byteLength;
      prelude = concat(preludeChunks, preludeSize);

      while (prelude.byteLength - parsedOffset >= 4) {
        const length = pktLength(prelude.subarray(parsedOffset, parsedOffset + 4));
        if (length === 0) {
          parsedOffset += 4;
          complete = true;
          break;
        }
        if (length < 4)
          throw new TaskWorkerReceivePackError('unsupported receive-pack control packet');
        if (length > maxPreludeBytes) {
          throw new TaskWorkerReceivePackError('receive-pack command packet is too large');
        }
        if (prelude.byteLength - parsedOffset < length) break;
        const payload = prelude.subarray(parsedOffset + 4, parsedOffset + length);
        commands.push(parseCommand(payload, commands.length === 0));
        if (commands.length > 1) {
          throw new TaskWorkerReceivePackError(
            'task worker receive-pack must contain exactly one command',
            403,
          );
        }
        parsedOffset += length;
      }
      if (!complete && preludeSize >= maxPreludeBytes) {
        throw new TaskWorkerReceivePackError('receive-pack command prelude is too large');
      }
    }

    if (commands.length !== 1) {
      throw new TaskWorkerReceivePackError(
        'task worker receive-pack must contain exactly one command',
        403,
      );
    }
    const command = commands[0];
    if (!command) throw new TaskWorkerReceivePackError('receive-pack command is missing');
    validateCommand(command, input.workerSessionId);
    acceptedCommand = command;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  let replayIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (replayIndex < replay.length) {
        const chunk = replay[replayIndex++];
        if (chunk) controller.enqueue(chunk);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        receivedBytes += next.value.byteLength;
        if (receivedBytes > maxBodyBytes) {
          const error = new TaskWorkerReceivePackError('receive-pack request body is too large');
          controller.error(error);
          await reader.cancel(error).catch(() => undefined);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  if (!acceptedCommand) throw new TaskWorkerReceivePackError('receive-pack command is missing');
  return { command: acceptedCommand, body };
}

/**
 * Consume the complete provider result before the durable request is settled.
 * The bounded copy lets the proxy replay the exact smart-HTTP response.
 */
export async function completeTaskWorkerReceivePackResponse(
  response: Response,
  maxBytes = TASK_WORKER_RECEIVE_PACK_MAX_RESPONSE_BYTES,
): Promise<Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative integer');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        throw new TaskWorkerReceivePackError('receive-pack response body is too large');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return new Response(concat(chunks, size), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
