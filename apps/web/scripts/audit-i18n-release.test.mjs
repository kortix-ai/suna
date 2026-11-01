import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('release source audit preserves technical values and recognizes translated messages', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-i18n-'));
  const fixture = new URL('../src/krtx-3817-audit-probe.tsx', import.meta.url);
  try {
    writeFileSync(fixture, `
      const t = useTranslations('spaces');
      const say = (key) => t(key);
      const ts = useTranslations('spaces');
      successToast(say('all'));
      errorToast(ts('all'));
      successToast('Could not save your changes');
      const a = <input placeholder='{ "reasoning": "high" }' />;
      const b = <input placeholder="Describe the agent" />;
      const c = <div>No content yet.</div>;
    `);
    const output = path.join(dir, 'audit.json');
    spawnSync(
      process.execPath,
      ['scripts/audit-i18n.mjs', '--max-hardcoded=0', `--json=${output}`],
      { encoding: 'utf8', cwd: new URL('..', import.meta.url) },
    );
    const { hardcoded } = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(
      hardcoded.filter((item) => item.file.endsWith('krtx-3817-audit-probe.tsx')).map((item) => item.text).sort(),
      ['Could not save your changes', 'Describe the agent', 'No content yet.'],
    );
    const files = new Set([
      'agent-drives-section.tsx',
      'agent-model-view.tsx',
      'agent-tabs.ts',
      'create-agent-modal.tsx',
      'connectors-page.tsx',
      'account-secret-resources-panel.tsx',
      'agent-editor-basics-fields.tsx',
      'capability-library.tsx',
      'catalog-space-tabs.tsx',
      'subagent-dialog-content.tsx',
      'peer-message-row.tsx',
      'sessions-board.tsx',
      'space-blocks.tsx',
      'space-templates.ts',
    ]);
    assert.deepEqual(
      hardcoded.filter((item) => files.has(path.basename(item.file))),
      [],
    );
  } finally {
    rmSync(fixture, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
