import { describe, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../translations/en.json';

// Pages are inspected before unrelated visual children render. Supply the real
// English translator without invoking a provider hook outside React.
mock.module('@/i18n/use-translations', () => ({
  useTranslations: (namespace?: string) => createTranslator({ locale: 'en', messages, namespace }),
}));
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import AgentComputer from '@/app/[locale]/(public)/(marketing)/agent-computer/page';
import AgentsAndSkills from '@/app/[locale]/(public)/(marketing)/agents-and-skills/page';
import Automations from '@/app/[locale]/(public)/(marketing)/automations/page';
import Channels from '@/app/[locale]/(public)/(marketing)/channels/page';
import CompanyAsCode from '@/app/[locale]/(public)/(marketing)/company-as-code/page';
import Security from '@/app/[locale]/(public)/(marketing)/security/page';
import SelfHosted from '@/app/[locale]/(public)/(marketing)/self-hosted/page';

type Props = { children?: ReactNode; id?: string; rows?: readonly { id: string; k: string; v: string }[] };

function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...elements(child.props.children)];
  });
}

function named(node: ReactNode, name: string) {
  return elements(node).filter((element) => typeof element.type === 'function' && element.type.name === name);
}

const ROW_CLASS = 'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-7';
const TERM_CLASS = 'text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4';
const VALUE_CLASS = 'text-muted-foreground text-sm leading-relaxed sm:col-span-8';
const FRAME = 'border-border bg-card overflow-hidden rounded-sm border';

for (const [name, Page] of [['security', Security], ['self-hosted', SelfHosted]] as const) {
  describe(`${name} definition rows`, () => {
    test('empty rows retain the exact definition-list frame', async () => {
      const lists = named(await Page(), 'RowList');
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) {
        expect(renderToStaticMarkup(cloneElement(list, { rows: [] }))).toBe(`<dl class="${FRAME}"></dl>`);
      }
    });

    test('multiple rows preserve ordered terms, responsive classes, borders and escaped text', async () => {
      const rows = [
        { id: 'first', k: '<key>&"', v: '<script>synthetic</script>&"' },
        { id: 'second', k: 'Repeated', v: 'Same value' },
        { id: 'third', k: 'Repeated', v: 'Same value' },
      ];
      const expected = `<dl class="${FRAME}">` +
        `<div class="${ROW_CLASS}"><dt class="${TERM_CLASS}">&lt;key&gt;&amp;&quot;</dt><dd class="${VALUE_CLASS}">&lt;script&gt;synthetic&lt;/script&gt;&amp;&quot;</dd></div>` +
        [1, 2].map(() => `<div class="${ROW_CLASS} border-t"><dt class="${TERM_CLASS}">Repeated</dt><dd class="${VALUE_CLASS}">Same value</dd></div>`).join('') + '</dl>';
      const lists = named(await Page(), 'RowList');
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) expect(renderToStaticMarkup(cloneElement(list, { rows }))).toBe(expected);
    });
  });
}

const ROUTES = [
  ['agent-computer', AgentComputer],
  ['agents-and-skills', AgentsAndSkills],
  ['automations', Automations],
  ['channels', Channels],
  ['company-as-code', CompanyAsCode],
  ['security', Security],
  ['self-hosted', SelfHosted],
] as const;

describe('capability dividers', () => {
  for (const [name, Page] of ROUTES) {
    test(`${name} preserves divider output and section order`, async () => {
      const tree = await Page();
      const dividers = named(tree, 'SectionDivider');
      expect(dividers.length).toBeGreaterThan(0);
      for (const divider of dividers) {
        expect(renderToStaticMarkup(divider)).toMatchSnapshot();
      }
      const order = elements(tree).flatMap((element) => {
        if (element.type === 'section') return [`section:${element.props.id ?? ''}`];
        if (typeof element.type === 'function' && element.type.name === 'SectionDivider') return ['divider'];
        return [];
      });
      expect(order).toMatchSnapshot();
    });
  }
});
