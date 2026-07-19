import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ICON_WEIGHTS } from '@/lib/icons/icon-config';
import { IconProvider } from '@/components/ui/icon-provider';
import { IconWeightSwitcher } from './icon-weight-switcher';

describe('IconWeightSwitcher', () => {
  test('renders a button per phosphor weight with the active one pressed', () => {
    const html = renderToStaticMarkup(
      <IconProvider>
        <IconWeightSwitcher />
      </IconProvider>,
    );
    for (const weight of ICON_WEIGHTS) {
      expect(html).toContain(`>${weight}</button>`);
    }
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html).toContain('aria-label="Icon weight"');
  });
});
