// Regenerate the committed canonical Slack app manifests from the SINGLE
// builder (src/channels/slack-manifest.ts). The committed JSON files are
// paste-into-Slack artifacts — never hand-edit them; edit the builder/config
// and run:  bun run scripts/gen-slack-manifest.ts
//
// A unit test (unit-slack-manifest.test.ts) asserts the committed files equal
// this output, so they can never drift from the builder again.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSlackManifest, CANONICAL_DEV, CANONICAL_PROD } from '../src/channels/slack-manifest';

const channelsDir = join(import.meta.dir, '..', 'src', 'channels');

const targets: Array<[string, ReturnType<typeof buildSlackManifest>]> = [
  ['slack-app-manifest.json', buildSlackManifest(CANONICAL_DEV)],
  ['slack-app-manifest.prod.json', buildSlackManifest(CANONICAL_PROD)],
];

for (const [file, manifest] of targets) {
  writeFileSync(join(channelsDir, file), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
console.log('Done — canonical Slack manifests regenerated from buildSlackManifest.');
