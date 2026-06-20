import { createInstallationToken } from '../src/projects/github';
import { execSync } from 'node:child_process';

const installId = process.env.MANAGED_GIT_GITHUB_INSTALL_ID!;
const owner = 'kortixd';
// pick a recent kortixd repo to test cloning with an APP install token
const repo = process.argv[2] || 'test-new11-e6f47c9d-fc71-4330-9f60-e5f99c957a1c';
console.log('installId:', installId, 'repo:', repo);
try {
  const minted = await createInstallationToken(installId, [repo]);
  console.log('app install token minted:', String(minted.token).slice(0, 12) + '...', 'expires:', minted.expiresAt ?? '?');
  const url = `https://x-access-token:${minted.token}@github.com/${owner}/${repo}.git`;
  execSync('rm -rf /tmp/apptok-clone', { stdio: 'ignore' });
  const t0 = Date.now();
  execSync(`git clone --progress ${url} /tmp/apptok-clone`, { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60000 });
  console.log(`APP-TOKEN CLONE OK in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
} catch (e: any) {
  console.log('APP TOKEN/CLONE FAILED:', e?.message?.slice(0, 200));
}
process.exit(0);
