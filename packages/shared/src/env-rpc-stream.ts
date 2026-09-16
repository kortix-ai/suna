export interface RpcProgress {
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export const RPC_STREAM_CONTENT_TYPE = 'application/x-ndjson';

export function isRpcProgress(value: unknown): value is RpcProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Partial<RpcProgress>;
  return (
    (progress.stream === 'stdout' || progress.stream === 'stderr') &&
    typeof progress.chunk === 'string'
  );
}

export class RpcStreamDecoder {
  private pending = '';
  private ended = false;
  private result: unknown;

  constructor(private readonly onProgress?: (progress: RpcProgress) => void) {}

  push(chunk: string): void {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      if (newline > 32 * 1024 * 1024) throw new Error('RPC stream frame exceeds 32 MiB');
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (!line.trim()) continue;
      if (this.ended) throw new Error('RPC stream continues after its result');
      const frame = JSON.parse(line);
      if (frame?.type === 'progress' && isRpcProgress(frame.progress))
        this.onProgress?.(frame.progress);
      else if (frame?.type === 'result' && typeof frame.body?.ok === 'boolean') {
        this.ended = true;
        this.result = frame.body;
      } else throw new Error('Invalid RPC stream frame');
    }
    if (this.pending.length > 32 * 1024 * 1024) throw new Error('RPC stream frame exceeds 32 MiB');
  }

  finish(): any {
    if (this.pending.trim() || !this.ended)
      throw new Error('RPC stream ended without a complete result');
    return this.result;
  }
}

export async function readRpcResponse(
  response: Response,
  onProgress?: (progress: RpcProgress) => void,
): Promise<any> {
  if (!response.headers.get('content-type')?.includes(RPC_STREAM_CONTENT_TYPE))
    return response.json();
  if (!response.body) throw new Error('RPC stream has no body');
  const reader = response.body.getReader();
  const text = new TextDecoder();
  const frames = new RpcStreamDecoder(onProgress);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      frames.push(text.decode(value, { stream: true }));
    }
    frames.push(text.decode());
    return frames.finish();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
