import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const webRoot = join(import.meta.dir, '../../..');

function source(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), 'utf8');
}

describe('Workspace user-facing terminology', () => {
  test('member management uses Workspace terminology', () => {
    const english = source('translations/en.json');

    expect(english).toContain('"line92JsxTextProjectMembers": "Workspace members"');
    expect(english).toContain(
      '"line94JsxTextControlWhoCanAccessThisProjectAccountOwners": "Manage who can access this workspace and their roles."',
    );
    expect(english).toContain(
      '"line141JsxAttrDescriptionAddAnExistingKortixUserToThisProject": "Add an existing Kortix user to this workspace."',
    );
    expect(english).toContain('"line260JsxAttrTitleProjectAccess": "Workspace access"');
  });

  test('session and channel empty-state labels use Workspace terminology', () => {
    const schedule = source('src/components/projects/schedule-view.tsx');
    const channels = source(
      'src/features/workspace/customize/sections/view/channels-view.tsx',
    );

    expect(schedule).toContain('No sessions in this workspace yet.');
    expect(schedule).not.toContain('No sessions in this project yet.');
    expect(channels).toContain("label: 'Workspace members can join'");
    expect(channels).not.toContain("label: 'Project members can join'");
  });
});
