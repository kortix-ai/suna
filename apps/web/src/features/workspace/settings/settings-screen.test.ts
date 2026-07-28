import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_SRC = join(import.meta.dir, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(WEB_SRC, ...parts), 'utf8');
/** Doc comments describe the markup they removed; assert against real code. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

const route = read('app', '(app)', 'projects', '[id]', 'settings', '[tab]', 'page.tsx');
const strip = read('features', 'workspace', 'settings', 'settings-tab-strip.tsx');
const generalView = read(
  'features',
  'workspace',
  'customize',
  'sections',
  'view',
  'settings-view.tsx',
);
const repositoryView = read(
  'features',
  'workspace',
  'customize',
  'sections',
  'view',
  'git-view.tsx',
);
const repositoryCard = read('features', 'workspace', 'settings', 'repository-config-card.tsx');

describe('settings is one flat tab strip', () => {
  test('the strip is the only navigation and renders no second title', () => {
    expect(strip).toContain('PROJECT_SETTINGS_TABS');
    expect(code(strip)).not.toContain('<h1');
    expect(code(strip)).not.toContain('<h2');
  });

  test('models stays gated on the gateway being available', () => {
    expect(strip).toContain('isLlmGatewayAvailable');
    expect(strip).toContain("tab.key !== 'models' || gatewayAvailable");
  });

  test('the strip carries no sidebar toggle of its own', () => {
    // One control, in the sidebar; ShellInset renders the single reopener for
    // the collapsed state. Per-toolbar copies produced duplicates.
    expect(code(strip)).not.toContain('SidebarPeekToggle');
  });

  test('every tab still resolves to the view it always did', () => {
    for (const view of [
      'SettingsView',
      'MembersView',
      'SecretsView',
      'GitView',
      'SandboxView',
      'LlmManagementView',
      'UpgradesView',
    ]) {
      expect(route).toContain(`<${view} projectId={projectId} />`);
    }
  });

  test('the shell owns the header for migrated tabs', () => {
    expect(route).toContain('<ProjectSectionPage');
    expect(route).toContain('title={meta.title}');
    expect(route).toContain('description={meta.description}');
    expect(route).toContain('meta.bodyOwnsHeader');
  });

  test('an unknown tab still redirects to General instead of 404ing', () => {
    expect(route).toContain('DEFAULT_PROJECT_SETTINGS_TAB');
    expect(route).toContain('router.replace(projectSettingsHref(projectId,');
  });

  test('the llm deep-link key still remounts the body', () => {
    expect(route).toContain("searchParams.get('llm')");
  });
});

describe('migrated tab bodies render no header of their own', () => {
  test('General dropped its duplicate "Settings" wrapper', () => {
    expect(code(generalView)).not.toContain('<CustomizeSectionWrapper');
    expect(code(generalView)).not.toContain('title="Settings"');
  });

  test('Repository dropped its duplicate "Git" wrapper', () => {
    expect(code(repositoryView)).not.toContain('<CustomizeSectionWrapper');
    expect(code(repositoryView)).not.toContain('title="Git"');
  });
});

describe('repository metadata lives on exactly one tab', () => {
  test('General no longer edits the repository', () => {
    expect(code(generalView)).not.toContain('RepositoryCard');
    expect(code(generalView)).not.toContain('listProjectBranches');
    expect(code(generalView)).not.toContain('inviteRepoCollaborator');
  });

  test('the editable repository card renders inside the Repository tab', () => {
    expect(repositoryView).toContain('RepositoryConfigCard');
    expect(repositoryView.indexOf('<ConnectionSummary')).toBeLessThan(
      repositoryView.indexOf('<RepositoryConfigCard'),
    );
  });

  test('no capability was dropped in the move', () => {
    for (const capability of [
      'listProjectBranches',
      'inviteRepoCollaborator',
      'isManagedGithubProject',
      'manifest-path',
      'default-branch',
      'View on GitHub',
    ]) {
      expect(repositoryCard).toContain(capability);
    }
  });

  test('the card resolves the project itself so a partial payload cannot blank the manifest', () => {
    expect(repositoryCard).toContain("queryKey: ['project', projectId]");
    expect(repositoryCard).toContain('getProject(projectId)');
  });
});

describe('General keeps everything it owned', () => {
  test('the danger zone is still the last block', () => {
    expect(generalView).toContain('DangerZone');
    expect(generalView.indexOf('DangerZone')).toBeGreaterThan(
      generalView.indexOf('<GeneralProjectCard'),
    );
  });

  test('the trigger kill-switch is untouched pending its move to Automations', () => {
    expect(generalView).toContain('TriggersActivationCard');
    expect(generalView).toContain('setProjectTriggersActivation');
  });

  test('experimental features stay behind one disclosure', () => {
    expect(generalView).toContain('<Disclosure');
    expect(generalView).toContain('SandboxProviderRow');
  });

  test('archiving still confirms before it runs', () => {
    expect(generalView).toContain('<ConfirmDialog');
    expect(generalView).toContain('archiveProject');
  });
});

describe('design system', () => {
  test('no hand-rolled spinner classes', () => {
    for (const source of [generalView, repositoryView, repositoryCard, strip, route]) {
      expect(source).not.toContain('animate-spin"');
      expect(source).not.toContain('Loader2');
    }
  });
});
