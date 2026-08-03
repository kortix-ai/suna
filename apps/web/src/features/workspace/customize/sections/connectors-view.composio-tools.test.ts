import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const connectorsSource = readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8');
const toolsPath = join(import.meta.dir, 'composio-tools-catalogue.tsx');
const toolsSource = existsSync(toolsPath) ? readFileSync(toolsPath, 'utf8') : '';

describe('Composio Tools connector catalogue', () => {
  test('makes Tools the primary add-connector path when Composio is configured', () => {
    expect(connectorsSource).toContain('const defaultTab = composioConfigured');
    expect(connectorsSource).toContain(
      'const [selectedTab, setSelectedTab] = useState<string | undefined>();',
    );
    expect(connectorsSource).toContain(
      '<Tabs value={selectedTab ?? defaultTab} onValueChange={setSelectedTab}>',
    );
    expect(connectorsSource).not.toContain('<Tabs defaultValue={defaultTab}>');
    const toolsTab = connectorsSource.indexOf(
      '{composioConfigured && <TabsTrigger value="tools">Tools</TabsTrigger>}',
    );
    const appsTab = connectorsSource.indexOf('<TabsTrigger value="apps"');
    expect(toolsTab).toBeGreaterThanOrEqual(0);
    expect(appsTab).toBeGreaterThanOrEqual(0);
    expect(toolsTab).toBeLessThan(appsTab);
  });

  test('adds a status-gated Tools tab without replacing existing connector paths', () => {
    expect(connectorsSource).toContain('getComposioStatus');
    expect(connectorsSource).toContain(
      'const composioConfigured = composioStatus.data?.configured === true',
    );
    expect(connectorsSource).toContain(
      '{composioConfigured && <TabsTrigger value="tools">Tools</TabsTrigger>}',
    );
    expect(connectorsSource).toContain('<TabsTrigger value="channels">Channels</TabsTrigger>');
    expect(connectorsSource).toContain('<TabsTrigger value="custom">Custom</TabsTrigger>');
  });

  test('renders a separate Tools catalogue with paginated toolkit and tool queries', () => {
    expect(toolsSource).toContain('listComposioToolkits(projectId');
    expect(toolsSource).toContain('listComposioTools(projectId, selectedToolkit.slug');
    expect(toolsSource).toContain('Load more');
    expect(toolsSource).toContain('connectComposioToolkit(projectId, selectedToolkit.slug');
  });

  test('keeps pagination available when a short search filters the current page to zero rows', () => {
    expect(toolsSource).toContain('toolkits.length === 0 && toolkitsQuery.hasNextPage');
  });

  test('renders toolkit and tool loading failure and empty states', () => {
    expect(toolsSource).toContain('Toolkits could not load');
    expect(toolsSource).toContain('No toolkits found');
    expect(toolsSource).toContain('Tools could not load');
    expect(toolsSource).toContain('No tools found');
    expect(toolsSource).toContain('Retry');
  });

  test('falls back to a local toolkit mark when an upstream logo fails', () => {
    expect(toolsSource).toContain('onError={() => setImageFailed(true)}');
    expect(toolsSource).toContain('if (!toolkit.iconUrl || imageFailed)');
  });

  test('connects every toolkit through the server-owned Composio session route', () => {
    expect(toolsSource).toContain('connectComposioToolkit(');
    expect(toolsSource).toContain(
      'proposeComposioConnectorSlug(selectedToolkit.slug, existingSlugs)',
    );
    expect(toolsSource).toContain('Connect toolkit');
    expect(toolsSource).toContain('authorizationUrl');
    expect(toolsSource).not.toContain('Requires Composio auth setup');
    expect(toolsSource).not.toContain('createOnlyConnectorDraft');
  });
});
