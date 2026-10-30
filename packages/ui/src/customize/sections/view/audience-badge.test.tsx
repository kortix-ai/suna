import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../../primitives/tooltip';
import { AudienceBadge } from './audience-badge';

const render = (visibility: Parameters<typeof AudienceBadge>[0]['visibility']) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <AudienceBadge visibility={visibility} labels={['Maya Chen']} />
    </TooltipProvider>,
  );

describe('AudienceBadge', () => {
  test('is a plain secondary Badge with no icon', () => {
    const out = render({ kind: 'everyone' } as Parameters<typeof AudienceBadge>[0]['visibility']);
    expect(out).toContain('data-testid="account-visibility"');
    expect(out).not.toContain('<svg');
    expect(out).toContain('normal-case');
  });
});
