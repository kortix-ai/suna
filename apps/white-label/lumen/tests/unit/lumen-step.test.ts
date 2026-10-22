import { expect, test } from 'bun:test';
import { lumenStep, shellCommand } from '../../src/lib/lumen-step';

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

test('the kit path forms seen in a real thread map to steps (UXR3-2)', () => {
  expect(lumenStep('lumen matter && ls')).toBe("Listing the matter's documents");
  expect(lumenStep('python3 /drives/kit/1.3.3/lumen-kit/bin/lumen matter; echo ---; ls -la /workspace')).toBe("Listing the matter's documents");
  expect(lumenStep('L=/drives/kit/1.3.3/lumen-kit/bin/lumen; python3 $L docs')).toBe("Listing the matter's documents");
});

test('shellCommand reads an object input, Codex forms, and JSON text (complete or streaming)', () => {
  expect(shellCommand({ command: 'lumen docs' })).toBe('lumen docs');
  expect(shellCommand({ cmd: 'lumen docs' })).toBe('lumen docs');
  expect(shellCommand({ command: ['bash', '-lc', 'lumen docs'] })).toBe('bash -lc lumen docs');
  expect(shellCommand('{"command":"lumen search --query \\"cap\\"","description":"x"}')).toBe('lumen search --query "cap"');
  expect(shellCommand('{"command":"lumen read --page 2", "descr')).toBe('lumen read --page 2');
  expect(shellCommand('{"comm')).toBeNull();
  expect(shellCommand(null)).toBeNull();
});
