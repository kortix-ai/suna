import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Comment01Icon,
  Download01Icon,
  FileDiffIcon,
  HugeiconsIcon,
  MinusSignCircleIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  PlusSignCircleIcon,
  RotateClockwiseIcon,
  Search01Icon,
  SidebarLeftIcon,
  Upload01Icon,
} from './hugeicons-compat';

describe('hugeicons-compat', () => {
  test('every alias used by the vendored viewers is a renderable icon', () => {
    const icons = [
      ArrowLeft01Icon,
      ArrowRight01Icon,
      Comment01Icon,
      Download01Icon,
      FileDiffIcon,
      MinusSignCircleIcon,
      Moon02Icon,
      MoreHorizontalIcon,
      PlusSignCircleIcon,
      RotateClockwiseIcon,
      Search01Icon,
      SidebarLeftIcon,
      Upload01Icon,
    ];
    for (const icon of icons) {
      const html = renderToStaticMarkup(<HugeiconsIcon icon={icon} className="size-4" />);
      expect(html).toContain('<svg');
      expect(html).toContain('size-4');
    }
  });
});
