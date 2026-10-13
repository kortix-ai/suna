import { describe, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../translations/en.json';

// Pages are inspected before unrelated visual children render. Supply the real
// English translator without invoking a provider hook outside React.
mock.module('@/i18n/use-translations', () => ({
  useTranslations: (namespace?: string) => createTranslator({ locale: 'en', messages, namespace }),
}));
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Product from '@/app/[locale]/(public)/(marketing)/product/page';
import { RowList } from '@/features/marketing/component/public-route-helpers';

type Props = { children?: ReactNode; id?: string };

function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...elements(child.props.children)];
  });
}

const ROW_CLASS = 'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-7';
const TERM_CLASS = 'text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4';
const VALUE_CLASS = 'text-muted-foreground text-sm leading-relaxed sm:col-span-8';
const FRAME = 'border-border bg-card overflow-hidden rounded-sm border';

describe('RowList', () => {
  test('empty rows retain the exact definition-list frame', () => {
    expect(renderToStaticMarkup(<RowList rows={[]} />)).toBe(`<dl class="${FRAME}"></dl>`);
  });

  test('multiple rows preserve ordered terms, responsive classes, borders and escaped text', () => {
    const rows = [
      { id: 'first', k: '<key>&"', v: '<script>synthetic</script>&"' },
      { id: 'second', k: 'Repeated', v: 'Same value' },
      { id: 'third', k: 'Repeated', v: 'Same value' },
    ];
    const expected =
      `<dl class="${FRAME}">` +
      `<div class="${ROW_CLASS}"><dt class="${TERM_CLASS}">&lt;key&gt;&amp;&quot;</dt><dd class="${VALUE_CLASS}">&lt;script&gt;synthetic&lt;/script&gt;&amp;&quot;</dd></div>` +
      [1, 2]
        .map(
          () =>
            `<div class="${ROW_CLASS} border-t"><dt class="${TERM_CLASS}">Repeated</dt><dd class="${VALUE_CLASS}">Same value</dd></div>`,
        )
        .join('') +
      '</dl>';
    expect(renderToStaticMarkup(<RowList rows={rows} />)).toBe(expected);
  });
});

describe('/product', () => {
  test('carries the four anchors the Product menu links to, in order', () => {
    const ids = elements(Product())
      .filter((element) => element.type === 'section')
      .map((element) => element.props.id);
    expect(ids).toEqual(['agents', 'connect', 'automate', 'control', 'developers']);
  });
});
