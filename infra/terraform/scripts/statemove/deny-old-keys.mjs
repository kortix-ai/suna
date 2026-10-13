// Fail-closed freeze of moved state keys in the old us-west-2 bucket: adds (or extends) one bucket-policy
// statement that denies PutObject/DeleteObject on those keys for every principal. Saves the previous policy.
// usage: node infra/terraform/scripts/statemove/deny-old-keys.mjs <group...> | --show | --remove
//        groups: dev global staging prod
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const BUCKET = 'kortix-terraform-state';
const SID = 'DenyWritesToMovedTerraformState';
const GROUPS = {
  dev: ['dev-us-east-2/ecs-api.tfstate', 'dev-us-east-2/ecs-web.tfstate'],
  global: ['security/baseline.tfstate', 'security/compliance-monitoring.tfstate'],
  staging: ['staging-eu-west-2/ecs-api.tfstate', 'staging-eu-west-2/ecs-web.tfstate'],
  prod: ['prod/ecs-api.tfstate', 'prod/ecs-web.tfstate'],
};
// Credentials: AWS_PROFILE if set, else the `kortix` profile.
const aws = (...a) => execFileSync('aws', [...a, '--profile', process.env.AWS_PROFILE || 'kortix', '--region', 'us-west-2', '--output', 'json']).toString();
let policy;
try { policy = JSON.parse(JSON.parse(aws('s3api', 'get-bucket-policy', '--bucket', BUCKET)).Policy); }
catch (e) { if (!String(e.stderr).includes('NoSuchBucketPolicy')) throw e; policy = { Version: '2012-10-17', Statement: [] }; }
const backup = `${tmpdir()}/kortix-terraform-state-policy.${Date.now()}.json`;
writeFileSync(backup, JSON.stringify(policy, null, 1));
console.log(`previous bucket policy saved to ${backup}`);
const args = process.argv.slice(2);
const others = policy.Statement.filter((s) => s.Sid !== SID);
const current = policy.Statement.find((s) => s.Sid === SID);
const frozen = new Set((current ? [].concat(current.Resource) : []).map((r) => r.replace(`arn:aws:s3:::${BUCKET}/`, '')));
if (args[0] === '--show') { console.log(`frozen keys: ${[...frozen].join(', ') || 'none'}`); process.exit(0); }
if (args[0] === '--remove') frozen.clear();
else for (const g of args) { if (!GROUPS[g]) throw new Error(`unknown group ${g}`); GROUPS[g].forEach((k) => frozen.add(k)); }
const next = { ...policy, Statement: [...others, ...(frozen.size ? [{
  Sid: SID, Effect: 'Deny', Principal: '*', Action: ['s3:PutObject', 's3:DeleteObject'],
  Resource: [...frozen].sort().map((k) => `arn:aws:s3:::${BUCKET}/${k}`),
}] : [])] };
if (next.Statement.length) aws('s3api', 'put-bucket-policy', '--bucket', BUCKET, '--policy', JSON.stringify(next));
else aws('s3api', 'delete-bucket-policy', '--bucket', BUCKET);
console.log(`frozen keys now: ${[...frozen].sort().join(', ') || 'none'}`);
