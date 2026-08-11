import { randomUUID } from 'node:crypto';
import { type Ports, computePorts, sh } from '../../scripts/worktree/lib';

const POSTGRES_IMAGE = 'postgres:16-alpine';

export const dockerAvailable = sh(['docker', 'info']).ok;

export class DisposablePostgres {
  readonly container: string;
  readonly explicitPort: number | undefined;
  private hostPort: number | undefined;

  constructor(prefix: string, portEnvironmentVariable: string) {
    this.container = `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const configured = process.env[portEnvironmentVariable];
    if (configured !== undefined) {
      const port = Number(configured);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${portEnvironmentVariable} must be an integer from 1 through 65535`);
      }
      this.explicitPort = port;
    }
  }

  get port(): number {
    if (this.hostPort === undefined) throw new Error('disposable Postgres has not started');
    return this.hostPort;
  }

  get ports(): Ports {
    return { ...computePorts(0), sbDb: this.port };
  }

  get url(): string {
    return `postgresql://postgres:postgres@127.0.0.1:${this.port}/postgres`;
  }

  async start(): Promise<void> {
    const publishedPort = this.explicitPort
      ? `127.0.0.1:${this.explicitPort}:5432`
      : '127.0.0.1::5432';
    const up = sh([
      'docker',
      'run',
      '-d',
      '--name',
      this.container,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_DB=postgres',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-p',
      publishedPort,
      POSTGRES_IMAGE,
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);

    if (this.explicitPort !== undefined) {
      this.hostPort = this.explicitPort;
    } else {
      const inspect = sh([
        'docker',
        'inspect',
        '--format',
        '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
        this.container,
      ]);
      const port = Number(inspect.stdout.trim());
      if (!inspect.ok || !Number.isInteger(port) || port < 1) {
        this.stop();
        throw new Error(`could not resolve test container port: ${inspect.stderr}`);
      }
      this.hostPort = port;
    }

    for (let attempt = 0; attempt < 60; attempt++) {
      if (this.isReady()) return;
      await Bun.sleep(1000);
    }
    this.stop();
    throw new Error('test Postgres never became ready');
  }

  stop(): void {
    sh(['docker', 'rm', '-f', this.container]);
  }

  private isReady(): boolean {
    return sh(['docker', 'exec', this.container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'])
      .ok;
  }
}
