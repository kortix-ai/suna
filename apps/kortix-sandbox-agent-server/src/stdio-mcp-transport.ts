import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const supervisor = `
import os,sys,signal,subprocess,time,sqlite3
parent=int(sys.argv[1]); lockpath=sys.argv[2]; child=None; stopped=False
if sys.platform.startswith('linux'):
 import ctypes
 if ctypes.CDLL(None).prctl(36,1,0,0,0) != 0: raise RuntimeError('Cannot supervise MCP descendants')
def stop(*args):
 global stopped
 stopped=True
signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
lock=None
try:
 if lockpath:
  os.makedirs(os.path.dirname(lockpath),exist_ok=True)
  lock=sqlite3.connect(lockpath,timeout=0,isolation_level=None)
  lock.execute('BEGIN'); lock.execute('SELECT name FROM sqlite_master').fetchall()
 if stopped or os.getppid()!=parent: sys.exit(1)
 child=subprocess.Popen(sys.argv[3:],start_new_session=True)
 while not stopped and os.getppid()==parent and child.poll() is None: time.sleep(0.02)
finally:
 if child is not None:
  try: os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  child.wait()
  if sys.platform.startswith('linux'):
   while True:
    try: os.waitpid(-1,0)
    except ChildProcessError: break
 if lock is not None: lock.close()
`;

export class EnvironmentStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = new ReadBuffer({ maxBufferSize: 12 * 1024 * 1024 });
  private closed?: Promise<void>;
  private resolveClosed?: () => void;
  private ended = false;
  constructor(
    private options: {
      command: string[];
      cwd: string;
      env: Record<string, string>;
      historyLock?: string;
    },
  ) {}
  async start(): Promise<void> {
    if (this.child || this.ended)
      throw new Error('MCP transport cannot be restarted');
    const child = (this.child = spawn(
      'python3',
      [
        '-c',
        supervisor,
        String(process.pid),
        this.options.historyLock ?? '',
        ...this.options.command,
      ],
      {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    ));
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    child.stderr.resume();
    child.stdin.on('error', (error) => this.fail(error));
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.ended) return;
      try {
        this.buffer.append(chunk);
        for (
          let message = this.buffer.readMessage();
          message;
          message = this.buffer.readMessage()
        )
          this.onmessage?.(message);
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error('Malformed MCP response'),
        );
      }
    });
    child.on('error', (error) => {
      this.onerror?.(error);
      this.finish();
    });
    child.on('close', () => this.finish());
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }
  private fail(error: Error) {
    this.onerror?.(error);
    void this.close();
  }
  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.buffer.clear();
    this.resolveClosed?.();
    this.onclose?.();
  }
  kill(): void {
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
  }
  async close(): Promise<void> {
    if (!this.child) {
      this.finish();
      return;
    }
    this.kill();
    await this.closed;
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.ended || this.child.stdin.destroyed)
      throw new Error('MCP connection is closed');
    const encoded = serializeMessage(message);
    if (Buffer.byteLength(encoded) > 1024 * 1024)
      throw new Error('MCP request exceeds 1 MiB');
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin.write(encoded, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
}
