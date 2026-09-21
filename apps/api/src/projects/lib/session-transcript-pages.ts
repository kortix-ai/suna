import {
  mirrorRowsFromOpencodePayload,
  type MirrorMessage,
} from "./session-transcript-mirror";

export async function readTranscriptPages(
  readPage: (cursor?: string) => Promise<Response>,
  fullHistory: boolean,
  prepareMessages?: (messages: unknown[]) => Promise<unknown[]>,
): Promise<{ rows: MirrorMessage[]; headComplete: boolean }> {
  const messages = new Map<string, MirrorMessage>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let headComplete = false;
  do {
    const response = await readPage(cursor);
    if (!response.ok)
      throw new Error(`Transcript read failed: HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("Invalid transcript page");
    for (const row of mirrorRowsFromOpencodePayload(
      prepareMessages ? await prepareMessages(payload) : payload,
    )) {
      const id = String(row.info.id);
      if (!messages.has(id)) messages.set(id, row);
    }
    cursor = response.headers.get("x-next-cursor") || undefined;
    headComplete = !cursor;
    if (cursor && cursors.has(cursor))
      throw new Error("Repeated transcript cursor");
    if (cursor) cursors.add(cursor);
  } while (fullHistory && cursor);
  const rows = [...messages.values()].sort((a, b) => {
    const created = (row: MirrorMessage) =>
      Number((row.info.time as { created?: number })?.created ?? 0);
    return (
      created(a) - created(b) ||
      String(a.info.id).localeCompare(String(b.info.id))
    );
  });
  return { rows, headComplete };
}

export async function retryTranscriptCapture<T>(
  capture: () => Promise<T | null>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await capture();
      if (result !== null) return result;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    if (attempt < 2) await wait(250 * 2 ** attempt);
  }
  return null;
}
