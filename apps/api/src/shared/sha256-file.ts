import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streaming hex sha256 of a file on disk. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
