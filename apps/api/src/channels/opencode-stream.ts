export interface OpencodeEvent<TProps extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  properties: TProps;
}

export interface MessagePartDeltaProps extends Record<string, unknown> {
  sessionID: string;
  messageID: string;
  partID: string;
  field: string;
  delta: string;
}

export interface SessionIdleProps extends Record<string, unknown> {
  sessionID: string;
}

export interface SessionErrorProps extends Record<string, unknown> {
  sessionID: string;
  error?: unknown;
}

export async function* parseOpencodeSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<OpencodeEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true }))
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const record = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = decodeRecord(record);
        if (event) yield event;
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeRecord(record: string): OpencodeEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of record.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.replace(/^data:\s*/, ''));
    else if (line.startsWith('event:')) eventName = line.replace(/^event:\s*/, '').trim();
  }
  if (dataLines.length === 0) return null;

  const raw = dataLines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  const payload = (obj.payload && typeof obj.payload === 'object' ? obj.payload : obj) as Record<
    string,
    unknown
  >;
  const type = typeof payload.type === 'string' ? payload.type : eventName;
  if (!type) return null;
  const properties =
    payload.properties && typeof payload.properties === 'object'
      ? (payload.properties as Record<string, unknown>)
      : {};
  return { type, properties };
}

export function isMessagePartDelta(
  event: OpencodeEvent,
): event is OpencodeEvent<MessagePartDeltaProps> {
  if (event.type !== 'message.part.delta') return false;
  const p = event.properties;
  return (
    typeof p.sessionID === 'string' &&
    typeof p.messageID === 'string' &&
    typeof p.partID === 'string' &&
    typeof p.field === 'string' &&
    typeof p.delta === 'string'
  );
}

export function isSessionIdle(event: OpencodeEvent): event is OpencodeEvent<SessionIdleProps> {
  return event.type === 'session.idle' && typeof event.properties.sessionID === 'string';
}

export function isSessionError(event: OpencodeEvent): event is OpencodeEvent<SessionErrorProps> {
  return event.type === 'session.error' && typeof event.properties.sessionID === 'string';
}
