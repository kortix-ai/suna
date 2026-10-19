import { expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import de from '../../../../../../apps/web/translations/de.json';
import en from '../../../../../../apps/web/translations/en.json';
import { CatalogNoMatch } from './catalog-empty-state';

for (const count of [0, 1, 2]) {
  test(`English excluded apps uses complete count wording: ${count}`, () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
        <CatalogNoMatch query=" synthetic " excludedNoActions={count} />
      </NextIntlClientProvider>,
    );
    if (count > 0)
      expect(html).toContain(
        count === 1
          ? '1 app matches but publishes no actions an agent can call.'
          : '2 apps match but publish no actions an agent can call.',
      );
    else expect(html).not.toContain('no actions an agent can call.');
    expect(html).not.toContain(' synthetic ');
  });
}

test('German excluded apps has no English suffix fragments', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="de" timeZone="UTC" messages={de}>
      <CatalogNoMatch query="synthetic" excludedNoActions={1} />
    </NextIntlClientProvider>,
  );
  expect(html).not.toContain('call.');
  expect(html).toContain(
    de.hardcodedUi.i18nComplete.catalogExcludedNoActions.split('one {')[1].split('}')[0],
  );
});
