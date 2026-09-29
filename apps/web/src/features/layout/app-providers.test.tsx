import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('app providers keeps subscription sync around children and global dialogs', () => {
  const source = readFileSync(resolve(import.meta.dir, 'app-providers.tsx'), 'utf8');
  expect(source).toMatch(/<SubscriptionStoreSync>\s*\{children\}\s*\{isBillingEnabled\(\) && <GlobalUpgradeModal \/>\}\s*<ConnectorConnectionGateDialog \/>\s*<\/SubscriptionStoreSync>/);
  expect(source).toContain('if (!showSidebar) return content;');
  expect(source).toContain('<SidebarProvider defaultOpen={defaultSidebarOpen}>');
});
