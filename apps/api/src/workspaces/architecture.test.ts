import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const API_ROOT = join(import.meta.dir, '..');
const WORKSPACES_ROOT = import.meta.dir;
const PROJECTS_ROOT = join(API_ROOT, 'projects');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const PERSISTED_PROJECT_IDENTIFIERS = new Set([
  'projects',
  'projectAccessRequests',
  'projectGitConnections',
  'projectGitCredentials',
  'projectGroupGrants',
  'projectMembers',
  'projectSessionConnectorBindings',
  'projectSessionRuntimeContexts',
  'projectSessionSecretHandles',
  'projectSecrets',
  'projectSessions',
  'projectTriggerExecutions',
  'projectTriggerRuntime',
  'projectRole',
]);

const APPROVED_PROJECT_IDENTIFIERS = new Set([
  ...PERSISTED_PROJECT_IDENTIFIERS,
  // OpenCode uses Project for its own repository/runtime model.
  'RuntimeProjectInfo',
  'getCurrentProject',
  // Marketplace and manifest schemas intentionally retain registry:project and project:.
  'ProjectManifest',
  // Explicit migration readers for persisted pre-Workspace values.
  'LegacyProjectSession',
  // Legacy environment names remain paired with canonical Workspace names.
  'KORTIX_PROJECT_ID',
  'KORTIX_PROJECT_SECRET_NAMES',
  'KORTIX_PROJECT_SECRETS_REVISION',
]);

function pathOwnsApprovedProjectConcept(relativePath: string, identifier: string): boolean {
  if (
    relativePath === 'compat.ts' ||
    relativePath.startsWith('suna-migration/') ||
    relativePath === 'legacy-migration-rehydrate.ts' ||
    relativePath === 'opencode-session-snapshot.ts'
  ) {
    return true;
  }
  if (
    (relativePath === 'seed-files.ts' || relativePath === 'managed-repo-seed.ts') &&
    identifier === 'projectName'
  ) {
    return true;
  }
  // account_invitations.bootstrap_grants is persisted legacy JSON.
  if (relativePath === 'routes/r6.ts' && identifier === 'project_id') return true;
  // The manifest's top-level `project:` block and registry:project remain stable.
  if (relativePath === 'triggers.ts' && identifier === 'project') return true;
  // Compatibility input aliases remain accepted while canonical outputs use Workspace fields.
  if (identifier === 'project_name' || identifier === 'projectName') {
    return relativePath === 'provision-core.ts' || relativePath === 'routes/r2.ts';
  }
  return false;
}

describe('Workspace is the canonical API implementation', () => {
  test('canonical Workspace modules never import the legacy Project adapter', () => {
    const violations = sourceFiles(WORKSPACES_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return /from ['"]\.\.\/projects(?:\/|['"])/.test(source)
        ? [relative(API_ROOT, path)]
        : [];
    });

    expect(violations).toEqual([]);
  });

  test('the legacy Project namespace is a small adapter over Workspace', () => {
    const implementationFiles = sourceFiles(PROJECTS_ROOT).filter(
      (path) => !path.endsWith('/index.ts') && !path.endsWith('/compat.ts'),
    );
    expect(implementationFiles).toEqual([]);
    expect(readFileSync(join(PROJECTS_ROOT, 'index.ts'), 'utf8')).toContain('../workspaces');
  });

  test('canonical Workspace modules contain no unapproved Project identifiers or filenames', () => {
    const violations: string[] = [];

    for (const path of sourceFiles(WORKSPACES_ROOT)) {
      const relativePath = relative(WORKSPACES_ROOT, path);
      if (/project/i.test(relativePath)) violations.push(`${relativePath}: filename`);

      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && /project/i.test(node.text)) {
          if (
            !APPROVED_PROJECT_IDENTIFIERS.has(node.text) &&
            !pathOwnsApprovedProjectConcept(relativePath, node.text)
          ) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(`${relativePath}:${position.line + 1}:${node.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
