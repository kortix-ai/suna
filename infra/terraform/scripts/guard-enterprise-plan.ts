#!/usr/bin/env bun

export type PlanDecision = 'auto_apply' | 'manual_review' | 'blocked';

type ResourceChange = {
  address?: string;
  type?: string;
  change?: { actions?: string[] };
};

type TerraformPlan = {
  format_version?: string;
  resource_changes?: ResourceChange[];
};

export type GuardResult = {
  decision: PlanDecision;
  summary: { create: number; update: number; delete: number; replace: number; read: number; noop: number };
  reasons: Array<{ address: string; severity: 'manual_review' | 'blocked'; reason: string }>;
};

const REVIEW_TYPES = [
  /^aws_iam_/,
  /^aws_kms_/,
  /^aws_eks_access_/,
  /^aws_cloudwatch_event_permission$/,
  /^aws_security_group(_rule)?$/,
  /^aws_vpc_endpoint$/,
  /^aws_route(_table)?$/,
  /^aws_route_table_association$/,
  /^aws_network_acl/,
  /^aws_(default_security_group|flow_log|internet_gateway|nat_gateway|subnet|vpc)$/,
  /^aws_backup_/,
  /^aws_cloudtrail$/,
  /^aws_s3_bucket_(lifecycle_configuration|policy|public_access_block|server_side_encryption_configuration|versioning)$/,
  /^aws_secretsmanager_secret_policy$/,
];

const STATE_PLANE_TYPES = new Set([
  'aws_s3_bucket',
  'aws_s3_bucket_versioning',
  'aws_s3_bucket_server_side_encryption_configuration',
  'aws_dynamodb_table',
]);

export function classifyEnterprisePlan(plan: TerraformPlan): GuardResult {
  const summary = { create: 0, update: 0, delete: 0, replace: 0, read: 0, noop: 0 };
  const reasons: GuardResult['reasons'] = [];

  for (const resource of plan.resource_changes ?? []) {
    const address = resource.address ?? '<unknown>';
    const type = resource.type ?? address.split('.')[0] ?? '<unknown>';
    const actions = resource.change?.actions ?? [];
    const actionSet = new Set(actions);

    if (actionSet.has('delete') && actionSet.has('create')) {
      summary.replace += 1;
      reasons.push({ address, severity: 'blocked', reason: 'resource replacement is destructive' });
      continue;
    }
    if (actionSet.has('delete')) {
      summary.delete += 1;
      reasons.push({ address, severity: 'blocked', reason: 'resource deletion is never automatic' });
      continue;
    }
    if (actionSet.has('create')) summary.create += 1;
    if (actionSet.has('update')) summary.update += 1;
    if (actionSet.has('read')) summary.read += 1;
    if (actionSet.has('no-op')) summary.noop += 1;

    const known = actions.every((action) => ['create', 'update', 'read', 'no-op'].includes(action));
    if (!known || actions.length === 0) {
      reasons.push({ address, severity: 'blocked', reason: `unknown Terraform action set: ${actions.join(',') || '<empty>'}` });
      continue;
    }

    if (actions.some((action) => action === 'create' || action === 'update')) {
      if (REVIEW_TYPES.some((pattern) => pattern.test(type))) {
        reasons.push({ address, severity: 'manual_review', reason: `${type} changes an identity, trust, or network boundary` });
      } else if (STATE_PLANE_TYPES.has(type) && /enterprise-state|terraform-state|\.state\b/.test(address)) {
        reasons.push({ address, severity: 'manual_review', reason: `${type} changes the Terraform state trust plane` });
      }
    }
  }

  const decision: PlanDecision = reasons.some((reason) => reason.severity === 'blocked')
    ? 'blocked'
    : reasons.some((reason) => reason.severity === 'manual_review')
      ? 'manual_review'
      : 'auto_apply';

  return { decision, summary, reasons };
}

function usage(): never {
  console.error('Usage: guard-enterprise-plan.ts <terraform-show.json> [--json]');
  process.exit(64);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) usage();

  let plan: TerraformPlan;
  try {
    plan = JSON.parse(await Bun.file(file).text()) as TerraformPlan;
  } catch (error) {
    console.error(`Could not read Terraform plan JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(65);
  }

  const result = classifyEnterprisePlan(plan);
  if (args.includes('--json')) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`enterprise plan: ${result.decision}`);
    console.log(`create=${result.summary.create} update=${result.summary.update} delete=${result.summary.delete} replace=${result.summary.replace}`);
    for (const reason of result.reasons) console.log(`${reason.severity}: ${reason.address}: ${reason.reason}`);
  }

  process.exit(result.decision === 'auto_apply' ? 0 : result.decision === 'manual_review' ? 2 : 3);
}
