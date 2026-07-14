import type { EnterpriseImageRole } from './release-contract.ts';
import type { CommandRunner } from './process.ts';

export const DEPLOY_SERVICE_ROLES = ['api', 'gateway', 'frontend'] as const;
export type DeployServiceRole = (typeof DEPLOY_SERVICE_ROLES)[number];

export interface AwsIdentity {
  Account: string;
  Arn: string;
}

export interface EcsContext {
  region: string;
  expectedAccountId: string;
  instance: string;
  /** ECS cluster; also the family prefix. Defaults to kortix-<instance>. */
  clusterName: string;
  /** Secrets Manager ARN/id of the <instance>/runtime blob. */
  runtimeSecretArn: string;
  /** SSM parameter that records the live release, e.g. /kortix/<instance>/release. */
  releaseParamName: string;
  /**
   * JSON passed verbatim to `run-task --network-configuration` for the one-off
   * migrate task (awsvpc mode needs subnets + security groups). WS-TF supplies
   * this to the deployer/CLI from the cluster module outputs.
   */
  networkConfiguration?: string;
}

/** The digest-and-bundle fingerprint written to the SSM release parameter. */
export interface ReleaseRecord {
  version: string;
  digests: Record<DeployServiceRole, string>;
  supabase_bundle_sha: string;
  deployed_at: string;
}

export interface ServiceState {
  exists: boolean;
  digest: string | null;
  rolloutState: string | null;
  rolledBack: boolean;
}

const READONLY_TASK_DEF_FIELDS = [
  'taskDefinitionArn', 'revision', 'status', 'requiresAttributes',
  'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt',
] as const;

export class EcsControlPlane {
  constructor(
    private readonly runner: CommandRunner,
    readonly context: EcsContext,
  ) {}

  serviceName(role: DeployServiceRole): string {
    return `${this.context.clusterName}-${role}`;
  }

  migrateFamily(): string {
    return `${this.context.clusterName}-migrate`;
  }

  verifyIdentity(): AwsIdentity {
    const identity = this.awsJson<AwsIdentity>(['sts', 'get-caller-identity']);
    if (identity.Account !== this.context.expectedAccountId) {
      throw new Error(`AWS account mismatch: expected ${this.context.expectedAccountId}, received ${identity.Account}`);
    }
    return identity;
  }

  getSecretJson(arn: string): Record<string, string> {
    const response = this.awsJson<{ SecretString?: string }>([
      'secretsmanager', 'get-secret-value', '--secret-id', arn,
    ]);
    if (!response.SecretString) throw new Error(`secret ${arn} has no SecretString`);
    let value: unknown;
    try {
      value = JSON.parse(response.SecretString) as unknown;
    } catch (error) {
      throw new Error(`secret ${arn} is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`secret ${arn} must contain a JSON object`);
    }
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item !== 'string') throw new Error(`secret value ${key} must be a string`);
      result[key] = item;
    }
    return result;
  }

  /** Every key in the runtime secret becomes a task-def `secrets` entry (ecs-deploy.sh pattern). */
  secretsArray(secretArn: string, keys: string[]): Array<{ name: string; valueFrom: string }> {
    return [...keys].sort().map((name) => ({ name, valueFrom: `${secretArn}:${name}::` }));
  }

  readReleaseRecord(): ReleaseRecord | null {
    // get-parameters (plural) returns exit 0 with the name in InvalidParameters
    // when it is absent, so a missing breadcrumb never looks like a hard failure.
    const response = this.awsJson<{ Parameters?: Array<{ Value?: string }> }>([
      'ssm', 'get-parameters', '--names', this.context.releaseParamName,
    ]);
    const value = response.Parameters?.[0]?.Value;
    if (!value) return null;
    try {
      return JSON.parse(value) as ReleaseRecord;
    } catch {
      return null;
    }
  }

  writeReleaseRecord(record: ReleaseRecord): void {
    this.awsJson([
      'ssm', 'put-parameter', '--name', this.context.releaseParamName,
      '--type', 'String', '--overwrite', '--value', JSON.stringify(record),
    ]);
  }

  describeService(role: DeployServiceRole): ServiceState {
    const service = this.serviceName(role);
    const response = this.awsJson<{
      services?: Array<{
        status?: string;
        taskDefinition?: string;
        deployments?: Array<{ status?: string; rolloutState?: string; taskDefinition?: string }>;
      }>;
    }>(['ecs', 'describe-services', '--cluster', this.context.clusterName, '--services', service]);
    const found = response.services?.[0];
    if (!found || found.status !== 'ACTIVE') {
      return { exists: false, digest: null, rolloutState: null, rolledBack: false };
    }
    const deployments = found.deployments ?? [];
    const primary = deployments.find((entry) => entry.status === 'PRIMARY') ?? deployments[0];
    const rolloutState = primary?.rolloutState ?? null;
    const rolledBack = deployments.some((entry) => entry.rolloutState === 'ROLLED_BACK')
      || deployments.some((entry) => entry.rolloutState === 'FAILED');
    const digest = found.taskDefinition ? this.taskDefinitionDigest(found.taskDefinition, role) : null;
    return { exists: true, digest, rolloutState, rolledBack };
  }

  private taskDefinitionDigest(taskDefinition: string, role: DeployServiceRole): string | null {
    const td = this.describeTaskDefinition(taskDefinition);
    const container = pickContainer(td, role);
    const image = typeof container?.image === 'string' ? container.image : '';
    const at = image.lastIndexOf('@');
    const digest = at >= 0 ? image.slice(at + 1) : '';
    return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : null;
  }

  /** The task-def the service currently runs, used as the base for the next revision. */
  serviceTaskDefinition(role: DeployServiceRole): Record<string, unknown> {
    const response = this.awsJson<{ services?: Array<{ status?: string; taskDefinition?: string }> }>([
      'ecs', 'describe-services', '--cluster', this.context.clusterName, '--services', this.serviceName(role),
    ]);
    const found = response.services?.[0];
    if (!found || found.status !== 'ACTIVE' || !found.taskDefinition) {
      throw new Error(`service ${this.serviceName(role)} is not active; run terraform apply before deploying`);
    }
    return this.describeTaskDefinition(found.taskDefinition);
  }

  describeTaskDefinition(taskDefinition: string): Record<string, unknown> {
    const response = this.awsJson<{ taskDefinition?: Record<string, unknown> }>([
      'ecs', 'describe-task-definition', '--task-definition', taskDefinition,
    ]);
    if (!response.taskDefinition) throw new Error(`task definition ${taskDefinition} was not found`);
    return response.taskDefinition;
  }

  /**
   * Render a registerable task-def from the service's current one: strip the
   * read-only fields, then swap the target container's image + secrets. Mirrors
   * infra/scripts/ecs-deploy.sh so the ECS env can never drift from the secret.
   */
  renderTaskDefinition(
    base: Record<string, unknown>,
    containerName: string,
    image: string,
    secrets: Array<{ name: string; valueFrom: string }>,
  ): Record<string, unknown> {
    const rendered: Record<string, unknown> = { ...base };
    for (const field of READONLY_TASK_DEF_FIELDS) delete rendered[field];
    const containers = Array.isArray(rendered.containerDefinitions) ? rendered.containerDefinitions : [];
    const target = pickContainerByName(containers, containerName);
    if (!target) throw new Error(`task definition has no container named ${containerName}`);
    target.image = image;
    target.secrets = secrets;
    return rendered;
  }

  registerTaskDefinition(definition: Record<string, unknown>): string {
    const response = this.awsJson<{ taskDefinition?: { taskDefinitionArn?: string } }>([
      'ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(definition),
    ]);
    const arn = response.taskDefinition?.taskDefinitionArn;
    if (!arn) throw new Error('register-task-definition did not return a task definition ARN');
    return arn;
  }

  updateService(role: DeployServiceRole, taskDefinitionArn: string): void {
    this.awsJson([
      'ecs', 'update-service', '--cluster', this.context.clusterName,
      '--service', this.serviceName(role), '--task-definition', taskDefinitionArn,
      '--force-new-deployment',
    ]);
  }

  waitServicesStable(role: DeployServiceRole): void {
    // `aws ecs wait services-stable` blocks until the service settles; the
    // circuit breaker owns rolling a bad task-def back, so a settled service can
    // still be a rolled-back one — the caller re-reads state to detect that.
    this.awsRaw([
      'ecs', 'wait', 'services-stable', '--cluster', this.context.clusterName,
      '--services', this.serviceName(role),
    ]);
  }

  runTaskToCompletion(taskDefinitionArn: string): number {
    const args = [
      'ecs', 'run-task', '--cluster', this.context.clusterName,
      '--task-definition', taskDefinitionArn, '--launch-type', 'FARGATE', '--count', '1',
    ];
    if (this.context.networkConfiguration) {
      args.push('--network-configuration', this.context.networkConfiguration);
    }
    const started = this.awsJson<{ tasks?: Array<{ taskArn?: string }>; failures?: Array<{ reason?: string }> }>(args);
    const taskArn = started.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const reason = started.failures?.[0]?.reason ?? 'unknown';
      throw new Error(`migrate task did not start: ${reason}`);
    }
    return this.waitTaskExit(taskArn);
  }

  private waitTaskExit(taskArn: string): number {
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const response = this.awsJson<{
        tasks?: Array<{ lastStatus?: string; containers?: Array<{ exitCode?: number; reason?: string }> }>;
      }>(['ecs', 'describe-tasks', '--cluster', this.context.clusterName, '--tasks', taskArn]);
      const task = response.tasks?.[0];
      if (task?.lastStatus === 'STOPPED') {
        const exitCode = task.containers?.[0]?.exitCode;
        return typeof exitCode === 'number' ? exitCode : 1;
      }
      this.runner.run('sleep', ['5']);
    }
    throw new Error(`migrate task ${taskArn} did not stop within 20 minutes`);
  }

  awsJson<T = Record<string, unknown>>(args: string[]): T {
    const output = this.awsRaw(args);
    try {
      return JSON.parse(output || '{}') as T;
    } catch (error) {
      throw new Error(`AWS CLI returned invalid JSON for ${args[0]} ${args[1]}: ${(error as Error).message}`);
    }
  }

  awsRaw(args: string[]): string {
    return this.runner.run('aws', [...args, '--region', this.context.region, '--output', 'json']);
  }
}

function pickContainer(td: Record<string, unknown>, role: DeployServiceRole): Record<string, unknown> | null {
  const containers = Array.isArray(td.containerDefinitions) ? td.containerDefinitions : [];
  return pickContainerByName(containers, role) ?? (containers.length === 1 ? containers[0] as Record<string, unknown> : null);
}

function pickContainerByName(containers: unknown[], name: string): Record<string, unknown> | null {
  const named = containers.find((entry) => (
    typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).name === name
  ));
  if (named) return named as Record<string, unknown>;
  if (containers.length === 1 && typeof containers[0] === 'object' && containers[0] !== null) {
    return containers[0] as Record<string, unknown>;
  }
  return null;
}

export function imageRoleForService(role: DeployServiceRole): EnterpriseImageRole {
  return role;
}
