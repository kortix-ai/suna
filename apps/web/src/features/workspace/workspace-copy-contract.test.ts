import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = join(import.meta.dir, '../../..');

function source(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), 'utf8');
}

describe('Workspace user-facing terminology', () => {
  test('English translations do not present the retired Project noun', () => {
    const messages = JSON.parse(source('translations/en.json')) as Record<string, unknown>;
    const stableFilesystemPathKey =
      'hardcodedUi.componentsTunnelScopeEditorsShellScopeEditor.line96JsxAttrPlaceholderHomeUserProjectOptional';
    const violations: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        if (path !== stableFilesystemPathKey && /\bprojects?\b/i.test(value)) {
          violations.push(`${path}: ${value}`);
        }
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value)) {
        visit(child, path ? `${path}.${key}` : key);
      }
    };

    visit(messages, '');
    expect(violations).toEqual([]);
  });

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
    const schedule = source('src/components/workspaces/schedule-view.tsx');
    const channels = source('src/features/workspace/customize/sections/view/channels-view.tsx');

    expect(schedule).toContain('No sessions in this workspace yet.');
    expect(schedule).not.toContain('No sessions in this project yet.');
    expect(channels).toContain("label: 'Workspace members can join'");
    expect(channels).not.toContain("label: 'Project members can join'");
  });

  test('public connector setup completion uses Workspace terminology', () => {
    const connectorIntake = source('src/components/setup-links/connector-intake.tsx');

    expect(connectorIntake).toContain('is connected to this workspace.');
    expect(connectorIntake).not.toContain('is connected to this project.');
  });

  test('translated Workspace surfaces do not fall back to localized Project nouns', () => {
    const forbiddenByLocale: Record<string, RegExp> = {
      de: /Projekt/i,
      es: /\bproyectos?\b/i,
      fr: /\bprojets?\b/i,
      it: /\bprogett[oi]\b/i,
      ja: /プロジェクト/,
      pt: /\bprojetos?\b/i,
      zh: /项目/,
    };
    const stableLegacyValueKeys = [
      'componentsTunnelScopeEditorsShellScopeEditor.line96JsxAttrPlaceholderHomeUserProjectOptional',
    ];

    for (const [locale, forbidden] of Object.entries(forbiddenByLocale)) {
      const messages = JSON.parse(
        source(`translations/${locale}.json`),
      ) as Record<string, unknown>;
      const violations: string[] = [];
      const visit = (value: unknown, path: string): void => {
        if (typeof value === 'string') {
          if (
            /project/i.test(path) &&
            !stableLegacyValueKeys.some((key) => path.endsWith(key)) &&
            forbidden.test(value)
          ) {
            violations.push(`${path}: ${value}`);
          }
          return;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        for (const [key, child] of Object.entries(value)) {
          visit(child, path ? `${path}.${key}` : key);
        }
      };

      visit(messages, '');
      expect(violations).toEqual([]);
    }
  });
});
