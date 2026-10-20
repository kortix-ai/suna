import { expect, test } from 'bun:test';
import { lumenStep } from '../../src/lib/lumen-step';

test('lumen commands read as plain steps', () => {
  expect(lumenStep('lumen search --query "limitation of liability" --k 8')).toBe('Searching the vault for "limitation of liability"');
  expect(lumenStep('lumen read --doc k17abc --anchor p3.12 --context 2')).toBe('Reading a document, p. 3');
  expect(lumenStep('cd /workspace && python3 /workspace/lumen-kit/bin/lumen cite check --file c.json')).toBe('Checking citations against the source');
  expect(lumenStep('lumen matter; echo "---"; ls /workspace')).toBe("Listing the matter's documents");
  expect(lumenStep('lumen result done --status succeeded')).toBe('Finishing up');
  expect(lumenStep('L="python3 /workspace/lumen-kit/bin/lumen"; $L read --doc kn7dgk46 --page 2')).toBe('Reading a document, p. 2');
  expect(lumenStep('L="python3 /workspace/lumen-kit/bin/lumen"; M=/drives/company/Lumen/Matters/x; ${L} search --query cap')).toBe('Searching the vault for "cap"');
  expect(lumenStep('lumen result write --schema issues --out out/issues.json --file /tmp/i.json')).toBe('Saving the results');
});

test('anything else keeps the stock shell row', () => {
  expect(lumenStep('ls -la /workspace')).toBeNull();
  expect(lumenStep('cat lumen-notes.txt')).toBeNull();
  expect(lumenStep('lumen unknown-subcommand')).toBeNull();
});
