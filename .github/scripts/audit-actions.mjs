/**
 * Gate: every remote `uses:` in a credential-holding workflow is pinned to a
 * full 40-hex commit SHA.
 *
 * A workflow holds credentials when it requests `id-token: write` (the OIDC
 * trust that exchanges into AWS), reads a credential through the aws-env
 * action (the only credential path in this repository), or maps an `AWS_*`
 * variable straight from a `${{ secrets.* }}` fallback. A mutable ref
 * (`@v4`, `@main`) in such a workflow lets a compromised upstream swap the
 * action's source under an unchanged workflow; a SHA pin freezes it.
 *
 * Red/green: exits 1 while any credential-holding workflow still has an
 * unpinned remote ref, exits 0 when all are pinned. Run it on a clean
 * checkout to see the pre-fix state; the positive control is this same tree
 * with every unpinned ref pinned.
 *
 * Usage: node .github/scripts/audit-actions.mjs [repo-root]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const dir = join(root, '.github', 'workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

const CREDENTIAL_MARKERS = [
  /id-token:\s*write/,
  // The local aws-env action lives at ./.aws-env/.github/actions/aws-env.
  /uses:\s*\.\/\.aws-env\/\.github\/actions\/aws-env/,
  /AWS_[A-Z_]+:\s*\$\{\{\s*secrets\./,
];
// Remote refs: `owner/repo@ref` and subpath actions (`owner/repo/path@ref`).
// The first character must be alphanumeric so local `./...` and `docker://`
// refs stay out; `.` is otherwise legal inside segments.
const REMOTE_USES = /uses:\s*["']?([a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)+)@([^"'\s]+)/g;
const SHA = /^[0-9a-f]{40}$/i;

let remoteRefs = 0;
let pinnedRefs = 0;
let credentialWorkflows = 0;
let credentialViolations = 0;
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  const refs = [...text.matchAll(REMOTE_USES)];
  remoteRefs += refs.length;
  const unpinned = refs.filter(([, , ref]) => !SHA.test(ref));
  pinnedRefs += refs.length - unpinned.length;
  const holdsCredentials = CREDENTIAL_MARKERS.some((marker) => marker.test(text));
  if (!holdsCredentials) continue;
  credentialWorkflows += 1;
  credentialViolations += unpinned.length;
  for (const [, action, ref] of unpinned) console.error(`${file}: ${action}@${ref}`);
}

console.log(
  `workflows=${files.length} remote_refs=${remoteRefs} pinned=${pinnedRefs} ` +
    `unpinned=${remoteRefs - pinnedRefs} credentialWorkflows=${credentialWorkflows} ` +
    `credentialWorkflowViolations=${credentialViolations}`,
);
// ponytail: the gate covers credential-holding workflows only; non-credential
// workflows keep their mutable refs until someone scopes them in here.
process.exit(credentialViolations > 0 ? 1 : 0);
