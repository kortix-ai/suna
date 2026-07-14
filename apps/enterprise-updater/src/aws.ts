import { randomUUID } from 'node:crypto';

import type { InstalledReleaseState, ReleaseHistoryEntry } from './execution.ts';
import type { CommandRunner } from './process.ts';

interface AwsIdentity {
  Account: string;
  Arn: string;
}

interface AssumeRoleResponse {
  Credentials?: {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    SessionToken?: string;
  };
}

interface DynamoValue {
  S?: string;
  N?: string;
  L?: DynamoValue[];
  M?: Record<string, DynamoValue>;
  BOOL?: boolean;
  NULL?: boolean;
}

export interface AwsContext {
  region: string;
  expectedAccountId: string;
  stateTable: string;
  instance: string;
}

export class AwsControlPlane {
  readonly executionId = randomUUID();

  constructor(
    private readonly runner: CommandRunner,
    private readonly context: AwsContext,
  ) {}

  verifyIdentity(): AwsIdentity {
    const identity = this.awsJson<AwsIdentity>(['sts', 'get-caller-identity']);
    if (identity.Account !== this.context.expectedAccountId) {
      throw new Error(`AWS account mismatch: expected ${this.context.expectedAccountId}, received ${identity.Account}`);
    }
    return identity;
  }

  readState(): InstalledReleaseState {
    const response = this.awsJson<{ Item?: Record<string, DynamoValue> }>([
      'dynamodb', 'get-item', '--consistent-read', '--table-name', this.context.stateTable,
      '--key', JSON.stringify({ instance: { S: this.context.instance } }),
    ]);
    const item = response.Item;
    if (!item) return emptyState();
    return {
      release: optionalString(item.release),
      channel: requiredString(item.channel, 'stable') === 'stable' ? 'stable' : fail('stored release channel is not stable'),
      status: requiredString(item.status, 'unknown'),
      manifest_sha256: optionalString(item.manifest_sha256),
      updated_at: optionalString(item.updated_at),
      last_wal_archived_at: optionalString(item.last_wal_archived_at),
      last_wal_name: optionalString(item.last_wal_name),
      last_base_backup_at: optionalString(item.last_base_backup_at),
      last_base_backup_key: optionalString(item.last_base_backup_key),
      history: parseHistory(item.history),
    };
  }

  acquireLease(ttlSeconds = 3600): void {
    const now = Math.floor(Date.now() / 1000);
    const expires = now + ttlSeconds;
    this.awsJson([
      'dynamodb', 'update-item', '--table-name', this.context.stateTable,
      '--key', JSON.stringify({ instance: { S: this.context.instance } }),
      '--condition-expression', '(attribute_not_exists(recovery_in_progress) OR recovery_in_progress = :false) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at < :now OR lease_owner = :owner)',
      '--update-expression', 'SET lease_owner = :owner, lease_expires_at = :expires, #channel = if_not_exists(#channel, :stable)',
      '--expression-attribute-names', JSON.stringify({ '#channel': 'channel' }),
      '--expression-attribute-values', JSON.stringify({
        ':owner': { S: this.executionId }, ':now': { N: String(now) }, ':expires': { N: String(expires) },
        ':stable': { S: 'stable' }, ':false': { BOOL: false },
      }),
      '--return-values', 'NONE',
    ]);
  }

  recordSuccess(state: InstalledReleaseState, release: string, manifestSha256: string, action: string): void {
    const now = new Date().toISOString();
    const history = nextHistory(state.history, {
      release,
      manifest_sha256: manifestSha256,
      verified_at: now,
      status: 'healthy',
    });
    this.awsJson([
      'dynamodb', 'update-item', '--table-name', this.context.stateTable,
      '--key', JSON.stringify({ instance: { S: this.context.instance } }),
      '--condition-expression', 'lease_owner = :owner',
      '--update-expression', 'SET #release = :release, #channel = :stable, #status = :healthy, manifest_sha256 = :manifest, updated_at = :updated, history = :history, last_action = :action REMOVE lease_owner, lease_expires_at, last_error',
      '--expression-attribute-names', JSON.stringify({ '#release': 'release', '#channel': 'channel', '#status': 'status' }),
      '--expression-attribute-values', JSON.stringify({
        ':owner': { S: this.executionId }, ':release': { S: release }, ':stable': { S: 'stable' },
        ':healthy': { S: 'healthy' }, ':manifest': { S: manifestSha256 }, ':updated': { S: now },
        ':history': { L: history.map(historyValue) }, ':action': { S: action },
      }),
      '--return-values', 'NONE',
    ]);
  }

  recordNoop(state: InstalledReleaseState, reason: string): void {
    this.awsJson([
      'dynamodb', 'update-item', '--table-name', this.context.stateTable,
      '--key', JSON.stringify({ instance: { S: this.context.instance } }),
      '--condition-expression', 'lease_owner = :owner',
      '--update-expression', 'SET #status = :healthy, updated_at = :updated, last_action = :action REMOVE lease_owner, lease_expires_at, last_error',
      '--expression-attribute-names', JSON.stringify({ '#status': 'status' }),
      '--expression-attribute-values', JSON.stringify({
        ':owner': { S: this.executionId }, ':healthy': { S: state.status === 'healthy' ? 'healthy' : 'unchanged' },
        ':updated': { S: new Date().toISOString() }, ':action': { S: `noop: ${reason}` },
      }),
      '--return-values', 'NONE',
    ]);
  }

  recordFailure(error: Error): void {
    const message = error.message.slice(0, 1000);
    try {
      this.awsJson([
        'dynamodb', 'update-item', '--table-name', this.context.stateTable,
        '--key', JSON.stringify({ instance: { S: this.context.instance } }),
        '--condition-expression', 'lease_owner = :owner',
        '--update-expression', 'SET #status = :failed, updated_at = :updated, last_error = :error REMOVE lease_owner, lease_expires_at',
        '--expression-attribute-names', JSON.stringify({ '#status': 'status' }),
        '--expression-attribute-values', JSON.stringify({
          ':owner': { S: this.executionId }, ':failed': { S: 'failed' },
          ':updated': { S: new Date().toISOString() }, ':error': { S: message },
        }),
        '--return-values', 'NONE',
      ]);
    } catch (recordError) {
      process.stderr.write(`unable to record updater failure: ${(recordError as Error).message}\n`);
    }
  }

  getSecretJson(arn: string): Record<string, unknown> {
    const response = this.awsJson<{ SecretString?: string }>([
      'secretsmanager', 'get-secret-value', '--secret-id', arn,
    ]);
    if (!response.SecretString) throw new Error(`secret ${arn} has no SecretString`);
    try {
      const value = JSON.parse(response.SecretString) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('secret is not an object');
      return value as Record<string, unknown>;
    } catch (error) {
      throw new Error(`secret ${arn} is not valid JSON: ${(error as Error).message}`);
    }
  }

  assumeRole(roleArn: string): NodeJS.ProcessEnv {
    const expectedPrefix = `arn:aws:iam::${this.context.expectedAccountId}:role/`;
    if (!roleArn.startsWith(expectedPrefix) || /[\s"'`$]/.test(roleArn)) {
      throw new Error('apply role ARN must be a role in the pinned customer account');
    }
    const response = this.awsJson<AssumeRoleResponse>([
      'sts', 'assume-role', '--role-arn', roleArn,
      '--role-session-name', `kortix-updater-${this.executionId.slice(0, 8)}`,
      '--duration-seconds', '3600',
    ]);
    const credentials = response.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new Error('STS assume-role response did not contain complete temporary credentials');
    }
    return {
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
      AWS_REGION: this.context.region,
      AWS_DEFAULT_REGION: this.context.region,
      AWS_PROFILE: undefined,
    };
  }

  awsJson<T = Record<string, unknown>>(args: string[], env?: NodeJS.ProcessEnv): T {
    const output = this.runner.run('aws', [...args, '--region', this.context.region, '--output', 'json'], { env });
    try {
      return JSON.parse(output || '{}') as T;
    } catch (error) {
      throw new Error(`AWS CLI returned invalid JSON for ${args[0]} ${args[1]}: ${(error as Error).message}`);
    }
  }
}

function emptyState(): InstalledReleaseState {
  return {
    release: null,
    channel: 'stable',
    status: 'not-installed',
    manifest_sha256: null,
    updated_at: null,
    last_wal_archived_at: null,
    last_wal_name: null,
    last_base_backup_at: null,
    last_base_backup_key: null,
    history: [],
  };
}

function optionalString(value?: DynamoValue): string | null {
  return typeof value?.S === 'string' ? value.S : null;
}

function requiredString(value: DynamoValue | undefined, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function parseHistory(value?: DynamoValue): ReleaseHistoryEntry[] {
  if (!value?.L) return [];
  return value.L.flatMap((entry) => {
    const map = entry.M;
    const release = optionalString(map?.release);
    const manifest = optionalString(map?.manifest_sha256);
    const verified = optionalString(map?.verified_at);
    const status = optionalString(map?.status);
    if (!release || !manifest || !verified || (status !== 'healthy' && status !== 'rolled-back')) return [];
    return [{ release, manifest_sha256: manifest, verified_at: verified, status }];
  });
}

function historyValue(entry: ReleaseHistoryEntry): DynamoValue {
  return { M: {
    release: { S: entry.release }, manifest_sha256: { S: entry.manifest_sha256 },
    verified_at: { S: entry.verified_at }, status: { S: entry.status },
  } };
}

function nextHistory(history: ReleaseHistoryEntry[], next: ReleaseHistoryEntry): ReleaseHistoryEntry[] {
  return [next, ...history.filter((entry) => (
    entry.release !== next.release || entry.manifest_sha256 !== next.manifest_sha256
  ))].slice(0, 20);
}

function fail(message: string): never {
  throw new Error(message);
}
