import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PanelQuickNav } from './panel-quick-nav';

describe('PanelQuickNav', () => {
  test('Terminal always renders; Audit is absent without ids', () => {
    const html = renderToStaticMarkup(
      <PanelQuickNav onOpenTerminal={() => {}} showAudit={false} onOpenAudit={() => {}} />,
    );
    expect(html).toContain('Terminal');
    expect(html).not.toContain('Audit');
  });

  test('Audit renders once projectId && projectSessionId are known', () => {
    const html = renderToStaticMarkup(
      <PanelQuickNav onOpenTerminal={() => {}} showAudit onOpenAudit={() => {}} />,
    );
    expect(html).toContain('Audit');
  });

  test('amber pending-count pill renders the count when > 0', () => {
    const html = renderToStaticMarkup(
      <PanelQuickNav
        onOpenTerminal={() => {}}
        showAudit
        onOpenAudit={() => {}}
        auditPending={3}
      />,
    );
    expect(html).toContain('3');
    expect(html).toContain('bg-amber-400/30');
  });

  test('no pill when the pending count is 0', () => {
    const html = renderToStaticMarkup(
      <PanelQuickNav
        onOpenTerminal={() => {}}
        showAudit
        onOpenAudit={() => {}}
        auditPending={0}
      />,
    );
    expect(html).not.toContain('bg-amber-400/30');
  });
});
