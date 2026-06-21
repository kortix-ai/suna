import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

let cached: boolean | undefined;

export async function isDockerAvailable(): Promise<boolean> {
  if (cached !== undefined) return cached;
  if (process.env.SKIP_DOCKER_TESTS === '1') {
    cached = false;
    return cached;
  }
  try {
    await run('docker', ['info'], { timeout: 10_000 });
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}
