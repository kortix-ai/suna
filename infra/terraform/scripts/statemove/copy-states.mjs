// Copies Terraform state objects from the old us-west-2 bucket to their regional bucket,
// byte-identical, and proves it by SHA-256. Prints hashes, sizes and version ids only —
// never state content. Temp files are 0600 and deleted.
// usage: node infra/terraform/scripts/statemove/copy-states.mjs [--dry-run] <group...>
//        groups: dev global staging prod vps-demo (or "all")
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';

const OLD = { bucket: 'kortix-terraform-state', region: 'us-west-2' };
const EUW2 = { bucket: 'kortix-terraform-state-eu-west-2-935064898258', region: 'eu-west-2', kms: 'alias/kortix-terraform-state-eu-west-2' };
const USE2 = { bucket: 'kortix-terraform-state-us-east-2-935064898258', region: 'us-east-2', kms: 'alias/kortix-terraform-state-us-east-2' };
const USE1 = { bucket: 'kortix-terraform-state-us-east-1-935064898258', region: 'us-east-1', kms: 'alias/kortix-terraform-state-us-east-1' };
const GROUPS = {
  dev: [['dev-us-east-2/ecs-api.tfstate', USE2], ['dev-us-east-2/ecs-web.tfstate', USE2]],
  global: [['security/baseline.tfstate', EUW2], ['security/compliance-monitoring.tfstate', EUW2]],
  staging: [['staging-eu-west-2/ecs-api.tfstate', EUW2], ['staging-eu-west-2/ecs-web.tfstate', EUW2]],
  prod: [['prod/ecs-api.tfstate', EUW2], ['prod/ecs-web.tfstate', EUW2]],
  // External root: kortix-ai/kortix-vps-demo-infra (us-east-1).
  'vps-demo': [['vps-demo/terraform.tfstate', USE1]],
};
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const groups = args.filter((a) => a !== '--dry-run').flatMap((g) => (g === 'all' ? Object.keys(GROUPS) : [g]));
if (!groups.length || groups.some((g) => !GROUPS[g])) { console.error('usage: node copy-states.mjs [--dry-run] dev|global|staging|prod|vps-demo|all ...'); process.exit(2); }

// Credentials: AWS_PROFILE if set, else the `kortix` profile.
const aws = (...a) => execFileSync('aws', [...a, '--profile', process.env.AWS_PROFILE || 'kortix', '--output', 'json'], { maxBuffer: 1 << 26 }).toString();
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const tmp = mkdtempSync(`${tmpdir()}/tfstate-`);
chmodSync(tmp, 0o700);
let failed = 0;
try {
  for (const [key, to] of groups.flatMap((g) => GROUPS[g])) {
    const src = `${tmp}/src`;
    const meta = JSON.parse(aws('s3api', 'get-object', '--region', OLD.region, '--bucket', OLD.bucket, '--key', key, src));
    const h = sha(src);
    if (dry) { console.log(`DRY ${key}: ${meta.ContentLength} B sha256=${h.slice(0, 16)} old-version=${meta.VersionId} -> s3://${to.bucket}`); rmSync(src); continue; }
    const put = JSON.parse(aws('s3api', 'put-object', '--region', to.region, '--bucket', to.bucket, '--key', key, '--body', src,
      '--server-side-encryption', 'aws:kms', '--ssekms-key-id', to.kms, '--content-type', 'application/json'));
    const back = `${tmp}/back`;
    aws('s3api', 'get-object', '--region', to.region, '--bucket', to.bucket, '--key', key, back);
    const ok = sha(back) === h;
    if (!ok) failed++;
    // The CI guard (.github/actions/state-copy-guard) passes only while the old key's CURRENT version
    // carries this tag. Tag the exact version that was copied: a write after the copy is untagged.
    if (ok) aws('s3api', 'put-object-tagging', '--region', OLD.region, '--bucket', OLD.bucket, '--key', key,
      '--version-id', meta.VersionId, '--tagging', 'TagSet=[{Key=statemove,Value=copied}]');
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${key}: ${meta.ContentLength} B sha256=${h.slice(0, 16)} old-version=${meta.VersionId} new-version=${put.VersionId} kms=${put.SSEKMSKeyId ? 'yes' : 'NO'}${ok ? ' tagged' : ''}`);
    rmSync(src); rmSync(back);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
